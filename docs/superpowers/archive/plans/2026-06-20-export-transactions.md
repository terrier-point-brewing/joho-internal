# Export Transaction Model + Batch Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `batch_exports` with a new `export_transactions` table (one row per packaging variant shipped, with a status lifecycle and shipment grouping), replace `brew_batches.status`'s incorrect `archived` value with `complete` (triggered by full export, not cold-storage arrival), and introduce a user-configurable `excise_tax_rates` table replacing two hardcoded tax constants.

**Architecture:** One migration handles all schema changes (status rename + recompute, three new tables, dropping `batch_exports`, removing the `cold_storage → archived` auto-transition from the `record_batch_transfer` RPC). Two new `lib/production/` helpers (`batchCompletion.ts`, `exciseTax.ts`) get called from the existing `/api/production/cold-storage-export` route, which keeps its FIFO logic untouched and only changes what it writes. Every other reader of `batch_exports` (`/api/production/allocations`, `/api/production/exports` + `[id]`, `ExportTab.tsx`) gets repointed to the new table. A separate sweep task renames every `"archived"` string literal across the app to `"complete"`.

**Tech Stack:** Next.js 16 App Router, TypeScript, Tailwind v4, Supabase Postgres (raw SQL migrations), React Query.

## Global Constraints

- This repo has **no test runner configured** — verification per task is `npm run lint`, `npm run build`, and (where noted) a manual code-trace walkthrough. Do not introduce a new test framework.
- **Migrations are additive-only — never hand-edit an existing migration file.** Always create a new file in `supabase/migrations/`.
- **`npx supabase db push` is unreliable in this repo** due to a pre-existing mismatch between `supabase_migrations.schema_migrations` (which tracks ~90 fine-grained historical timestamps) and this repo's squashed/renamed local migration filenames. Do not run `supabase migration repair --status reverted` or any command that rewrites `schema_migrations` — a prior session run did this and it deleted all 90 tracking rows, requiring a manual SQL restore. Apply new migrations by pasting the SQL directly into the Supabase Dashboard SQL Editor (project `drlsazatrcrdwaihjmex`), then separately run `insert into supabase_migrations.schema_migrations (version) values ('<YYYYMMDD-prefix-of-the-new-migration-filename>') on conflict (version) do nothing;` so the CLI at least tracks the new migration going forward. Never attempt to fix the pre-existing 90-row mismatch as a side effect of this work.
- **Before every commit, verify you are in the correct git checkout/branch**, not `main`. Two prior implementer dispatches in this codebase's session history accidentally committed directly to `main` instead of an isolated worktree/branch — always run `git branch --show-current` immediately before `git commit` and confirm it matches the branch you were told to work on. If it shows `main` unexpectedly, STOP and do not commit.
- `brew_batches.status` has **no database check constraint** — it's a plain `text` column (per `supabase/migrations/20260609_baseline.sql:147`), enforced only by the TypeScript `BatchStatus` type and application code. The status-rename migration therefore needs no `alter ... drop constraint`/`add constraint` step, only data updates.
- `record_batch_transfer` RPC signature must not change — only the `case` statement mapping equipment type → status inside it changes (remove the `cold_storage → archived` line).
- The existing FIFO inventory-computation logic and request/response shapes in `/api/production/cold-storage-export/route.ts` (the `ExportLineItem`/`ColdStorageExportRequest` interfaces, the `kegNameToBbl` helper, the prior-exports-subtraction loop, the FIFO allocation loop) and in `ColdStorageExportModal.tsx` (the `product_label`/`product_type` matching-key convention) must NOT change — only what gets written at the end changes. Do not touch the FIFO matching contract between the modal and the route.

---

### Task 1: Migration — status rename, new tables, drop `batch_exports`

**Files:**
- Create: `supabase/migrations/20260622_export_transactions.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `public.export_transactions` (id, shipment_id, batch_id, recipe_id, allocation_id, packaging_item_id, variant_label, quantity, volume_bbl, channel, recipient_id, recipient_name, status, total_excise_tax_usd, source_transfer_id, notes, created_at); `public.excise_tax_rates` (id, name, receiving_party, unit, rate_usd, is_active, created_at, updated_at); `public.export_transaction_taxes` (id, export_transaction_id, excise_tax_rate_id, tax_name, unit, rate_usd, amount_usd, created_at); `brew_batches.status` recomputed so no row is `'archived'` (all become `'complete'` or `'packaging'`); `record_batch_transfer` RPC updated (same signature).

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260622_export_transactions.sql`:

```sql
-- Export Transaction model + batch completion (Spec 2a/4): replaces
-- batch_exports with a per-packaging-variant export_transactions table
-- (status lifecycle + shipment grouping), replaces brew_batches.status's
-- 'archived' value with 'complete' (triggered by full export, not
-- cold-storage arrival), and replaces hardcoded excise tax constants with
-- a user-configurable excise_tax_rates table.

-- ── 1. Recompute existing 'archived' batches before the value is repurposed ──
-- 'archived' previously fired the moment product arrived in cold storage,
-- before any of it was exported. Re-evaluate actual exhaustion: a batch
-- that's truly fully exported becomes 'complete'; one that just arrived in
-- cold storage but hasn't been exported yet goes back to 'packaging'.
update public.brew_batches b
set status = case when be.is_exhausted then 'complete' else 'packaging' end
from public.batch_exhaustion be
where be.batch_id = b.id
  and b.status = 'archived';

-- ── 2. Remove the cold_storage → archived auto-transition ────────────────────
create or replace function public.record_batch_transfer(
  p_batch_id       uuid,
  p_from_tank_id   uuid,
  p_to_tank_id     uuid,
  p_volume_bbl     numeric,
  p_shrinkage_bbl  numeric  default 0,
  p_transfer_type  text     default 'transfer',
  p_notes          text     default null,
  p_kegging_detail jsonb    default null,
  p_canning_detail jsonb    default null,
  p_created_by     uuid     default null
) returns public.batch_transfers language plpgsql as $$
declare
  v_transfer      public.batch_transfers;
  v_dest_type     text;
  v_new_status    text;
  v_cur_status    text;
  v_unconstrained text[] := array['kegging','canning','cold_storage','backlog','loading_bay','export_bay'];
begin
  insert into public.batch_transfers(
    batch_id, from_tank_id, to_tank_id, volume_bbl, shrinkage_bbl,
    transfer_type, notes, kegging_detail, canning_detail, created_by
  ) values (
    p_batch_id, p_from_tank_id, p_to_tank_id, p_volume_bbl, coalesce(p_shrinkage_bbl, 0),
    coalesce(p_transfer_type, 'transfer'), p_notes, p_kegging_detail, p_canning_detail,
    p_created_by
  ) returning * into v_transfer;

  update public.batch_tank_assignments
     set released_at = now()
   where batch_id = p_batch_id and released_at is null;

  if p_to_tank_id is not null then
    select type into v_dest_type from public.equipment where id = p_to_tank_id;
    if v_dest_type is not null then
      v_new_status := case v_dest_type
        when 'brewhouse'    then 'brewing'
        when 'fermenter'    then 'fermenting'
        when 'brite'        then 'conditioning'
        when 'kegging'      then 'packaging'
        when 'canning'      then 'packaging'
        else null
      end;
      if not (v_dest_type = any(v_unconstrained)) then
        if exists (select 1 from public.batch_tank_assignments where tank_id = p_to_tank_id and released_at is null) then
          raise exception 'Destination tank is already occupied';
        end if;
        insert into public.batch_tank_assignments(batch_id, tank_id, notes)
          values (p_batch_id, p_to_tank_id, null);
      end if;
      if v_new_status is not null then
        select status into v_cur_status from public.brew_batches where id = p_batch_id;
        if v_cur_status is distinct from v_new_status then
          update public.brew_batches set status = v_new_status where id = p_batch_id;
          insert into public.batch_status_history(batch_id, status, note)
            values (p_batch_id, v_new_status, 'Auto: transferred to ' || coalesce(p_transfer_type, 'transfer'));
        end if;
      end if;
    end if;
  end if;

  return v_transfer;
end;
$$;

-- ── 3. excise_tax_rates ───────────────────────────────────────────────────────
create table public.excise_tax_rates (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  receiving_party text,
  unit            text not null check (unit in ('bbl', 'gallon')),
  rate_usd        numeric not null,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

insert into public.excise_tax_rates (name, receiving_party, unit, rate_usd) values
  ('Federal Excise Tax', 'TTB', 'bbl', 3.50),
  ('NC Excise Tax', 'NC Department of Revenue', 'gallon', 0.62);

-- ── 4. export_transactions ────────────────────────────────────────────────────
create table public.export_transactions (
  id                      uuid primary key default gen_random_uuid(),
  shipment_id             uuid not null,
  batch_id                uuid not null references public.brew_batches(id) on delete cascade,
  recipe_id               uuid references public.recipes(id) on delete set null,
  allocation_id           uuid references public.batch_allocations(id) on delete set null,
  packaging_item_id       uuid not null references public.packaging_items(id) on delete restrict,
  variant_label           text not null,
  quantity                numeric not null,
  volume_bbl              numeric not null,
  channel                 text not null check (channel in ('taproom', 'distribution', 'contract_brewing')),
  recipient_id            uuid references public.contract_brewing_partners(id) on delete set null,
  recipient_name          text,
  status                  text not null default 'invoice_required' check (status in ('invoice_required', 'unpaid', 'paid')),
  total_excise_tax_usd    numeric not null default 0,
  source_transfer_id      uuid references public.batch_transfers(id) on delete set null,
  notes                   text,
  created_at              timestamptz not null default now()
);

create index export_transactions_shipment_idx on public.export_transactions(shipment_id);
create index export_transactions_batch_idx on public.export_transactions(batch_id);
create index export_transactions_allocation_idx on public.export_transactions(allocation_id);
create index export_transactions_status_idx on public.export_transactions(status);

-- ── 5. export_transaction_taxes ───────────────────────────────────────────────
create table public.export_transaction_taxes (
  id                    uuid primary key default gen_random_uuid(),
  export_transaction_id uuid not null references public.export_transactions(id) on delete cascade,
  excise_tax_rate_id    uuid references public.excise_tax_rates(id) on delete set null,
  tax_name              text not null,
  unit                  text not null,
  rate_usd              numeric not null,
  amount_usd            numeric not null,
  created_at            timestamptz not null default now()
);

create index export_transaction_taxes_export_idx on public.export_transaction_taxes(export_transaction_id);

-- ── 6. Drop batch_exports (green-field/test-only data, confirmed no backfill needed) ──
drop table if exists public.batch_exports;
```

- [ ] **Step 2: Apply the migration manually**

Per the Global Constraints, `npx supabase db push` is unreliable in this repo. Paste the full SQL from Step 1 into the Supabase Dashboard SQL Editor (project `drlsazatrcrdwaihjmex`) and run it. Then run this separately to register the migration in the CLI's tracking table:
```sql
insert into supabase_migrations.schema_migrations (version) values ('20260622') on conflict (version) do nothing;
```

- [ ] **Step 3: Verify**

Verify via the Supabase REST API (no `psql`/CLI access needed — same pattern used to verify Spec 1):
```bash
source .env.local
curl -s -o /dev/null -w "%{http_code}\n" "$SUPABASE_URL/rest/v1/export_transactions?select=id&limit=1" -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
curl -s -o /dev/null -w "%{http_code}\n" "$SUPABASE_URL/rest/v1/excise_tax_rates?select=id&limit=1" -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
curl -s -o /dev/null -w "%{http_code}\n" "$SUPABASE_URL/rest/v1/export_transaction_taxes?select=id&limit=1" -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
curl -s -o /dev/null -w "%{http_code}\n" "$SUPABASE_URL/rest/v1/batch_exports?select=id&limit=1" -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```
Expected: first three return `200`; the last returns `404` (table dropped). Also run:
```sql
select id, status from brew_batches where status = 'archived';
```
in the SQL editor — expected: zero rows.

- [ ] **Step 4: Commit**

```bash
git branch --show-current   # confirm NOT main before committing
git add supabase/migrations/20260622_export_transactions.sql
git commit -m "Add export_transactions, excise_tax_rates tables; replace archived status with complete"
```

---

### Task 2: TypeScript types

**Files:**
- Modify: `app/production/types.ts:1-27` (BatchStatus, EQUIPMENT_TYPE_TO_STATUS)
- Modify: `app/production/components/shared.tsx:7-14` (BATCH_STATUSES)

**Interfaces:**
- Consumes: nothing from Task 1 beyond the migrated schema.
- Produces: `BatchStatus` including `"complete"` not `"archived"`; new `ExportTransaction`, `ExciseTaxRate`, `ExportTransactionTax` interfaces consumed by Task 6/7.

- [ ] **Step 1: Update `BatchStatus` and `EQUIPMENT_TYPE_TO_STATUS`**

In `app/production/types.ts`, replace lines 1-27:

```ts
export type BatchStatus =
  | "planning"
  | "brewing"
  | "fermenting"
  | "conditioning"
  | "packaging"
  | "complete";

export type AdjustmentType = "received" | "used" | "waste" | "inventory_count" | "batch_use";

export type EquipmentType =
  | "fermenter" | "brite" | "brewhouse"
  | "cold_storage" | "kegging" | "canning" | "backlog"
  | "loading_bay" | "export_bay";

// Types that have no capacity constraint and don't hold a single batch
export const UNCONSTRAINED_EQUIPMENT_TYPES: EquipmentType[] = ["kegging", "canning", "cold_storage", "backlog", "loading_bay", "export_bay"];

// Map equipment type to the batch status it implies. cold_storage has no
// entry — arrival in cold storage no longer changes batch status; only a
// full export (see lib/production/batchCompletion.ts) transitions to "complete".
export const EQUIPMENT_TYPE_TO_STATUS: Partial<Record<EquipmentType, BatchStatus>> = {
  brewhouse:    "brewing",
  fermenter:    "fermenting",
  brite:        "conditioning",
  kegging:      "packaging",
  canning:      "packaging",
};
```

- [ ] **Step 2: Add `ExportTransaction`, `ExciseTaxRate`, `ExportTransactionTax` interfaces**

In `app/production/types.ts`, add after the `ColdStorageInventory` interface (added in Spec 1, currently right after `BatchTransfer`):

```ts
export type ExportChannel = "taproom" | "distribution" | "contract_brewing";
export type ExportTransactionStatus = "invoice_required" | "unpaid" | "paid";

export interface ExportTransaction {
  id: string;
  shipment_id: string;
  batch_id: string;
  recipe_id: string | null;
  allocation_id: string | null;
  packaging_item_id: string;
  variant_label: string;
  quantity: number;
  volume_bbl: number;
  channel: ExportChannel;
  recipient_id: string | null;
  recipient_name: string | null;
  status: ExportTransactionStatus;
  total_excise_tax_usd: number;
  source_transfer_id: string | null;
  notes: string | null;
  created_at: string;
  brew_batches?: { id: string; beer_name: string; batch_number: string | null } | null;
}

export interface ExciseTaxRate {
  id: string;
  name: string;
  receiving_party: string | null;
  unit: "bbl" | "gallon";
  rate_usd: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ExportTransactionTax {
  id: string;
  export_transaction_id: string;
  excise_tax_rate_id: string | null;
  tax_name: string;
  unit: "bbl" | "gallon";
  rate_usd: number;
  amount_usd: number;
  created_at: string;
}
```

- [ ] **Step 3: Rename `"archived"` to `"complete"` in `shared.tsx`**

In `app/production/components/shared.tsx`, replace line 13:
```ts
  { value: "archived",        label: "Archived",        color: "bg-zinc-800/50 text-zinc-500 border-zinc-700" },
```
with:
```ts
  { value: "complete",        label: "Complete",        color: "bg-zinc-800/50 text-zinc-500 border-zinc-700" },
```

- [ ] **Step 4: Verify it compiles**

Run: `npm run build`
Expected: build fails — confined to files Task 3 fixes (every other `"archived"` string-literal site listed in that task) and Task 6/7 (files reading the old `batch_exports`/`BatchExport` shape). If errors appear anywhere not covered by Tasks 3, 6, or 7, stop and investigate.

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # confirm NOT main before committing
git add app/production/types.ts app/production/components/shared.tsx
git commit -m "Replace archived BatchStatus with complete, add ExportTransaction/ExciseTaxRate types"
```

---

### Task 3: Rename `"archived"` → `"complete"` everywhere else

**Files:**
- Modify: `app/api/production/conversions/route.ts:188, 201`
- Modify: `app/api/production/batches/[id]/route.ts:75, 94`
- Modify: `app/api/production/recipes/[id]/route.ts:74`
- Modify: `app/production/components/EquipmentSchedule/index.tsx:76`
- Modify: `app/production/components/BrewStatusTab.tsx:249`
- Modify: `app/production/components/BatchLogTab.tsx:193-200, 1053, 1092-1093`

**Interfaces:**
- Consumes: `BatchStatus` from Task 2 (must already exclude `"archived"`).
- Produces: nothing new — every status-literal comparison/write in the app now uses `"complete"`, matching Task 2's type.

- [ ] **Step 1: `conversions/route.ts` — full-conversion archive**

In `app/api/production/conversions/route.ts`, the "Full conversion — archive the parent batch" block (around lines 187-202) currently reads:
```ts
  } else {
    // Full conversion — archive the parent batch
    await supabase.from("brew_batches").update({ status: "archived" }).eq("id", batch_id);

    // Close any open schedule entries on the parent
    await supabase
      .from("batch_schedule_entries")
      .update({ cancelled_at: new Date().toISOString(), cancellation_reason: "fully converted" })
      .eq("batch_id", batch_id)
      .is("cancelled_at", null)
      .is("actual_end", null);

    await supabase.from("batch_status_history").insert({
      batch_id,
      status:     "archived",
      note:       `Fully converted — all ${volume_bbl} BBL transferred to ${childBatch.batch_number}`,
      changed_by: currentUser?.id ?? null,
    });
  }
```
Replace `"archived"` with `"complete"` in both places (the `update({ status: ... })` call and the `status:` field in the `batch_status_history` insert) — leave every other line, including the comment text and the note string, unchanged except the comment word "archive" → "complete":
```ts
  } else {
    // Full conversion — mark the parent batch complete
    await supabase.from("brew_batches").update({ status: "complete" }).eq("id", batch_id);

    // Close any open schedule entries on the parent
    await supabase
      .from("batch_schedule_entries")
      .update({ cancelled_at: new Date().toISOString(), cancellation_reason: "fully converted" })
      .eq("batch_id", batch_id)
      .is("cancelled_at", null)
      .is("actual_end", null);

    await supabase.from("batch_status_history").insert({
      batch_id,
      status:     "complete",
      note:       `Fully converted — all ${volume_bbl} BBL transferred to ${childBatch.batch_number}`,
      changed_by: currentUser?.id ?? null,
    });
  }
```

- [ ] **Step 2: `batches/[id]/route.ts` — archive cascade + comment**

In `app/api/production/batches/[id]/route.ts`, replace line 75:
```ts
  if (statusChanged && newStatus === "archived") {
```
with:
```ts
  if (statusChanged && newStatus === "complete") {
```
And replace the comment block at lines 94-96:
```ts
    // batch_allocations, batch_exports, batch_transfers, batch_status_history,
    // and batch_brew_activity_log are intentionally left untouched — they are
    // financial or historical records and must not be invalidated on archive.
```
with:
```ts
    // batch_allocations, export_transactions, batch_transfers, batch_status_history,
    // and batch_brew_activity_log are intentionally left untouched — they are
    // financial or historical records and must not be invalidated on completion.
```
Also update the cancellation reason string a few lines above (within the same block, originally `cancellation_reason: "batch archived"`) to `cancellation_reason: "batch completed"`.

- [ ] **Step 3: `recipes/[id]/route.ts` — active-batch guard**

In `app/api/production/recipes/[id]/route.ts`, replace line 74:
```ts
    .neq("status", "archived");
```
with:
```ts
    .neq("status", "complete");
```
And the comment immediately above it (`// Guard: block deletion if any non-archived batch references this recipe`) becomes `// Guard: block deletion if any non-complete batch references this recipe`.

- [ ] **Step 4: `EquipmentSchedule/index.tsx`**

In `app/production/components/EquipmentSchedule/index.tsx`, replace line 76:
```ts
  const pkgStatuses = batch?.status !== "archived" ? computeBranchPackagingStatus(activeEntries, batch, allTransfers) : [];
```
with:
```ts
  const pkgStatuses = batch?.status !== "complete" ? computeBranchPackagingStatus(activeEntries, batch, allTransfers) : [];
```

- [ ] **Step 5: `BrewStatusTab.tsx`**

In `app/production/components/BrewStatusTab.tsx`, replace line 249:
```ts
  const unassignedBatches  = batches.filter((b) => b.status !== "archived" && b.status !== "packaging" && !assignedBatchIds.has(b.id));
```
with:
```ts
  const unassignedBatches  = batches.filter((b) => b.status !== "complete" && b.status !== "packaging" && !assignedBatchIds.has(b.id));
```

- [ ] **Step 6: `BatchLogTab.tsx` — manual Archive action + two display guards**

In `app/production/components/BatchLogTab.tsx`, replace the `handleArchive` function (around lines 193-200):
```ts
  async function handleArchive(id: string, name: string) {
    if (!confirm(`Archive batch "${name}"? Equipment will be released and scheduled work cancelled. Financial records will be preserved.`)) return;
    await fetch(`/api/production/batches/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "archived" }),
    });
    await refresh();
  }
```
with:
```ts
  async function handleComplete(id: string, name: string) {
    if (!confirm(`Mark batch "${name}" complete? Equipment will be released and scheduled work cancelled. Financial records will be preserved.`)) return;
    await fetch(`/api/production/batches/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "complete" }),
    });
    await refresh();
  }
```
Find every caller of `onArchive`/`handleArchive` in this file (the prop is threaded through as `onArchive` to the table row component — search for `onArchive` and `handleArchive`) and rename both the prop and the function reference to `onComplete`/`handleComplete` consistently, including the prop type declaration wherever it's declared (e.g. `onArchive: (id: string, name: string) => void` becomes `onComplete: (id: string, name: string) => void`).

Replace lines 1053 and 1092-1093 (the two `b.status !== "archived"` guards and the "Archive" button):
```tsx
                      {scheduleMissing && b.status !== "archived" && (
```
becomes
```tsx
                      {scheduleMissing && b.status !== "complete" && (
```
and
```tsx
                      {b.status !== "archived" && (
                        <button onClick={() => onArchive(b.id, b.beer_name)} className="text-xs text-zinc-500 hover:text-amber-400 transition-colors">Archive</button>
                      )}
```
becomes
```tsx
                      {b.status !== "complete" && (
                        <button onClick={() => onComplete(b.id, b.beer_name)} className="text-xs text-zinc-500 hover:text-amber-400 transition-colors">Complete</button>
                      )}
```

- [ ] **Step 7: Sweep for anything missed**

Run: `grep -rn '"archived"' app lib --include="*.ts" --include="*.tsx"`
Expected: zero matches. If any remain, fix them following the same `"archived"` → `"complete"` pattern (and rename any adjacent "archive"-themed comment/label/variable to "complete"-themed) before continuing.

- [ ] **Step 8: Build and lint**

Run: `npm run lint && npm run build`
Expected: clean (Tasks 6-7 are the remaining pieces — if errors appear in `cold-storage-export/route.ts`, `allocations/route.ts`, `exports/route.ts`, or `ExportTab.tsx`, that's expected and Tasks 5-7 fix them).

- [ ] **Step 9: Commit**

```bash
git branch --show-current   # confirm NOT main before committing
git add app/api/production/conversions/route.ts app/api/production/batches/\[id\]/route.ts app/api/production/recipes/\[id\]/route.ts app/production/components/EquipmentSchedule/index.tsx app/production/components/BrewStatusTab.tsx app/production/components/BatchLogTab.tsx
git commit -m "Rename archived status to complete across batch lifecycle code"
```

---

### Task 4: `lib/production/batchCompletion.ts` and `lib/production/exciseTax.ts`

**Files:**
- Create: `lib/production/batchCompletion.ts`
- Create: `lib/production/exciseTax.ts`

**Interfaces:**
- Consumes: `SupabaseClient` (from `@supabase/supabase-js`), the `excise_tax_rates`/`batch_exhaustion` tables from Task 1.
- Produces: `checkAndCompleteBatch(supabase, batchId): Promise<void>` and `computeExciseTaxBreakdown(supabase, volumeBbl): Promise<{ rateId: string | null; name: string; unit: "bbl" | "gallon"; rateUsd: number; amountUsd: number }[]>`, both consumed by Task 5.

- [ ] **Step 1: Write `lib/production/batchCompletion.ts`**

```ts
import { SupabaseClient } from "@supabase/supabase-js";

/**
 * Checks batch_exhaustion for the given batch and, if fully exhausted,
 * transitions it to "complete" (idempotent — no-op if already complete).
 * Replaces the old cold-storage-arrival trigger, which fired before any
 * export had actually happened.
 */
export async function checkAndCompleteBatch(supabase: SupabaseClient, batchId: string): Promise<void> {
  const { data: exhaustion } = await supabase
    .from("batch_exhaustion")
    .select("is_exhausted")
    .eq("batch_id", batchId)
    .single();
  if (!exhaustion?.is_exhausted) return;

  const { data: batch } = await supabase.from("brew_batches").select("status").eq("id", batchId).single();
  if (batch?.status === "complete") return;

  await supabase.from("brew_batches").update({ status: "complete" }).eq("id", batchId);
  await supabase.from("batch_status_history").insert({
    batch_id: batchId,
    status: "complete",
    note: "Auto: fully exported",
  });
}
```

- [ ] **Step 2: Write `lib/production/exciseTax.ts`**

```ts
import { SupabaseClient } from "@supabase/supabase-js";
import { GALLONS_PER_BBL } from "@/lib/constants/production";

export interface ExciseTaxLine {
  rateId: string | null;
  name: string;
  unit: "bbl" | "gallon";
  rateUsd: number;
  amountUsd: number;
}

/**
 * Computes the excise tax breakdown for a given volume by applying every
 * active excise_tax_rates row. Replaces the old hardcoded
 * FEDERAL_EXCISE_PER_BBL/NC_EXCISE_PER_GAL constants — any number of taxes
 * can apply, configured entirely via the excise_tax_rates table.
 */
export async function computeExciseTaxBreakdown(supabase: SupabaseClient, volumeBbl: number): Promise<ExciseTaxLine[]> {
  const { data: rates } = await supabase
    .from("excise_tax_rates")
    .select("id, name, unit, rate_usd")
    .eq("is_active", true);

  return (rates ?? []).map((r) => {
    const units = r.unit === "bbl" ? volumeBbl : volumeBbl * GALLONS_PER_BBL;
    const amountUsd = Math.round(r.rate_usd * units * 100) / 100;
    return { rateId: r.id, name: r.name, unit: r.unit as "bbl" | "gallon", rateUsd: r.rate_usd, amountUsd };
  });
}
```

- [ ] **Step 3: Build and lint**

Run: `npm run lint && npm run build`
Expected: clean (these are new, unused-until-Task-5 files — no existing code imports them yet, so this should not change any existing build/lint state from Task 3's end state).

- [ ] **Step 4: Commit**

```bash
git branch --show-current   # confirm NOT main before committing
git add lib/production/batchCompletion.ts lib/production/exciseTax.ts
git commit -m "Add batch-completion check and excise tax calculation helpers"
```

---

### Task 5: Refactor `/api/production/cold-storage-export/route.ts`

**Files:**
- Modify: `app/api/production/cold-storage-export/route.ts`

**Interfaces:**
- Consumes: `checkAndCompleteBatch` and `computeExciseTaxBreakdown` from Task 4.
- Produces: no change to the route's request/response shape — `POST /api/production/cold-storage-export` still accepts `ColdStorageExportRequest` and returns `{ created: [...] }` (the created `batch_transfers` rows, unchanged). Internally, `export_transactions` + `export_transaction_taxes` rows replace `batch_exports` rows.

- [ ] **Step 1: Add `packagingItemId`/`variantLabel` to the inventory pipeline**

In `app/api/production/cold-storage-export/route.ts`, the `InvEntry` type (around line 84-93) currently has no `packagingItemId`/`variantLabel` fields — add them:
```ts
  type InvEntry = {
    batchTransferId: string;
    batchId: string;
    productLabel: string;
    productType: "keg" | "can";
    totalQty: number;
    exportedQty: number;
    transferredAt: string;
    volumeFlOz: number | null; // per unit
    packagingItemId: string;
    variantLabel: string;
  };
```
In the loop building `inventory` (around lines 97-129), add the two new fields to both push calls. For the kegging branch:
```ts
        inventory.push({
          batchTransferId: tr.id,
          batchId: tr.batch_id,
          productLabel: kd.name,
          productType: "keg",
          totalQty: kd.quantity,
          exportedQty: 0,
          transferredAt: tr.transferred_at,
          volumeFlOz: flOz,
          packagingItemId: kd.packaging_id,
          variantLabel: kd.variant_label,
        });
```
For the canning branch:
```ts
        inventory.push({
          batchTransferId: tr.id,
          batchId: tr.batch_id,
          productLabel: "can",
          productType: "can",
          totalQty: totalCans,
          exportedQty: 0,
          transferredAt: tr.transferred_at,
          volumeFlOz: canVolumeFlOz,
          packagingItemId: cd.can_packaging_id,
          variantLabel: cd.variant_label,
        });
```
Do not change `productLabel`/`productType` — those remain the FIFO matching key, unchanged per the Global Constraints.

- [ ] **Step 2: Thread the new fields through `Allocation`**

The `Allocation` type (around line 148-155) currently has no `packagingItemId`/`variantLabel` — add them:
```ts
  type Allocation = {
    batchId: string;
    batchTransferId: string;
    productLabel: string;
    productType: "keg" | "can";
    quantity: number;
    volumeFlOz: number | null;
    packagingItemId: string;
    variantLabel: string;
  };
```
In the FIFO allocation loop (around lines 166-180), the `allocations.push({...})` call gets the two new fields copied from `inv`:
```ts
      allocations.push({
        batchId: inv.batchId,
        batchTransferId: inv.batchTransferId,
        productLabel: inv.productLabel,
        productType: inv.productType,
        quantity: take,
        volumeFlOz: inv.volumeFlOz,
        packagingItemId: inv.packagingItemId,
        variantLabel: inv.variantLabel,
      });
```

- [ ] **Step 3: Fetch `recipe_id` for every batch touched, and import the Task 4 helpers**

Near the top of the file, add the import:
```ts
import { checkAndCompleteBatch } from "@/lib/production/batchCompletion";
import { computeExciseTaxBreakdown } from "@/lib/production/exciseTax";
```
Right before the `byBatch` grouping loop (around line 201-206), add a batch-recipe lookup:
```ts
  const { data: batchRows } = await supabase
    .from("brew_batches")
    .select("id, recipe_id")
    .in("id", [...new Set(allocations.map((a) => a.batchId))]);
  const recipeIdByBatch = new Map((batchRows ?? []).map((b) => [b.id, b.recipe_id as string | null]));
```

- [ ] **Step 4: Replace the `batch_exports` insert loop with `export_transactions` + `export_transaction_taxes`**

Remove the existing constants `FEDERAL_EXCISE_PER_BBL`/`NC_EXCISE_PER_GAL` (lines 73-74) entirely — they're no longer used. Also remove `const BBL_TO_GAL = 31;` (line 72) — after this task it has no remaining reader in this file (its only use was the state-excise calculation being removed below); leave `BBL_FL_OZ` (line 71) untouched, it's still used for volume conversion.

Replace the existing "batch_exports — one row per product type per batch" loop (currently lines 245-275, inside the `for (const [batchId, allocs] of byBatch)` loop, right after the `batch_transfers` insert) with:
```ts
    // Generate one shipment_id per request, shared across every line this
    // POST creates (across all batches), so a later UI can select an
    // entire shipment at once.
    const exportTxRows = [];
    for (const alloc of allocs) {
      const volumeBbl = alloc.volumeFlOz != null
        ? Math.round((alloc.quantity * alloc.volumeFlOz / BBL_FL_OZ) * 10000) / 10000
        : 0;

      const taxBreakdown = await computeExciseTaxBreakdown(supabase, volumeBbl);
      const totalExciseTaxUsd = Math.round(taxBreakdown.reduce((s, t) => s + t.amountUsd, 0) * 100) / 100;

      const { data: exportTx, error: exErr } = await supabase
        .from("export_transactions")
        .insert({
          shipment_id: shipmentId,
          batch_id: batchId,
          recipe_id: recipeIdByBatch.get(batchId) ?? null,
          allocation_id: null,
          packaging_item_id: alloc.packagingItemId,
          variant_label: alloc.variantLabel,
          quantity: alloc.quantity,
          volume_bbl: volumeBbl,
          channel,
          recipient_id: channel === "contract_brewing" ? (partner_id ?? null) : null,
          recipient_name: channel === "contract_brewing"
            ? (partner_name ?? null)
            : (recipient_name ?? null),
          total_excise_tax_usd: totalExciseTaxUsd,
          source_transfer_id: transfer.id,
          notes: notes ?? null,
        })
        .select("id")
        .single();
      if (exErr) return NextResponse.json({ error: exErr.message }, { status: 500 });

      if (taxBreakdown.length > 0) {
        const { error: taxErr } = await supabase.from("export_transaction_taxes").insert(
          taxBreakdown.map((t) => ({
            export_transaction_id: exportTx.id,
            excise_tax_rate_id: t.rateId,
            tax_name: t.name,
            unit: t.unit,
            rate_usd: t.rateUsd,
            amount_usd: t.amountUsd,
          }))
        );
        if (taxErr) return NextResponse.json({ error: taxErr.message }, { status: 500 });
      }

      exportTxRows.push(exportTx);
    }

    await checkAndCompleteBatch(supabase, batchId);
```
Add `const shipmentId = crypto.randomUUID();` once, right before the `byBatch` grouping loop (the same place as Step 3's `recipeIdByBatch` lookup) — not inside the per-batch loop, since it must be shared across every batch in this request.

- [ ] **Step 5: Build and lint**

Run: `npm run lint && npm run build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git branch --show-current   # confirm NOT main before committing
git add app/api/production/cold-storage-export/route.ts
git commit -m "Write export_transactions + tax breakdown instead of batch_exports"
```

---

### Task 6: Repoint `/api/production/allocations`, `/api/production/exports`, `/api/production/exports/[id]`

**Files:**
- Modify: `app/api/production/allocations/route.ts:47-58`
- Modify: `app/api/production/exports/route.ts`
- Modify: `app/api/production/exports/[id]/route.ts`

**Interfaces:**
- Consumes: `export_transactions` table from Task 1.
- Produces: no response-shape change for `/api/production/allocations` (still returns allocations enriched with `exported_bbl`/`fulfilled`); `/api/production/exports` now returns `ExportTransaction[]`-shaped rows instead of the old `BatchExport[]` shape — consumed by Task 7.

- [ ] **Step 1: `allocations/route.ts` — repoint the fulfillment lookup**

Replace lines 47-58:
```ts
  // Fetch exports grouped by batch_id + channel + recipient_id for fulfillment
  const { data: exports_ } = await supabase
    .from("batch_exports")
    .select("batch_id, channel, recipient_id, volume_bbl")
    .in("batch_id", batchIds);

  // Build fulfillment lookup: key = `${batch_id}:${channel}:${recipient_id ?? ""}`
  const exportedMap: Record<string, number> = {};
  for (const e of exports_ ?? []) {
    const key = `${e.batch_id}:${e.channel}:${e.recipient_id ?? ""}`;
    exportedMap[key] = (exportedMap[key] ?? 0) + (e.volume_bbl ?? 0);
  }
```
with:
```ts
  // Fetch exports grouped by batch_id + channel + recipient_id for fulfillment
  const { data: exports_ } = await supabase
    .from("export_transactions")
    .select("batch_id, channel, recipient_id, volume_bbl")
    .in("batch_id", batchIds);

  // Build fulfillment lookup: key = `${batch_id}:${channel}:${recipient_id ?? ""}`
  const exportedMap: Record<string, number> = {};
  for (const e of exports_ ?? []) {
    const key = `${e.batch_id}:${e.channel}:${e.recipient_id ?? ""}`;
    exportedMap[key] = (exportedMap[key] ?? 0) + (e.volume_bbl ?? 0);
  }
```
Also update the doc comment at the top of the `GET` function (currently `// Returns allocations enriched with fulfillment data computed from batch_exports and batch_transfers.`) to say `export_transactions` instead of `batch_exports`.

- [ ] **Step 2: `exports/route.ts` — repoint GET, fix the `exported_at` ordering bug**

Replace the entire file:
```ts
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("export_transactions")
    .select("*, brew_batches(id, beer_name, batch_number)")
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

// All exports must go through /api/production/cold-storage-export to enforce
// FIFO inventory checks. Direct inserts to export_transactions are blocked here.
export async function POST() {
  return NextResponse.json(
    { error: "Use /api/production/cold-storage-export to record exports" },
    { status: 405 }
  );
}
```
(Note: the previous version ordered by `exported_at`, a column that never existed on `batch_exports` — this was already a latent bug; `created_at` is the correct column and exists on `export_transactions`.)

- [ ] **Step 3: `exports/[id]/route.ts` — repoint PATCH/DELETE**

Replace the entire file:
```ts
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requireRole("brewer"); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();

  const { id } = await params;
  const body = await req.json();
  const allowed = ["recipient_id", "recipient_name", "quantity", "variant_label", "volume_bbl", "notes", "status"];
  const updates: Record<string, unknown> = {};
  for (const k of allowed) if (k in body) updates[k] = body[k];

  const { data, error } = await supabase
    .from("export_transactions")
    .update(updates)
    .eq("id", id)
    .select("*, brew_batches(id, beer_name, batch_number)")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requireRole("brewer"); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();

  const { id } = await params;
  const { error } = await supabase.from("export_transactions").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
```

- [ ] **Step 4: Build and lint**

Run: `npm run lint && npm run build`
Expected: clean except for `ExportTab.tsx`, fixed in Task 7.

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # confirm NOT main before committing
git add app/api/production/allocations/route.ts app/api/production/exports/route.ts app/api/production/exports/\[id\]/route.ts
git commit -m "Repoint allocations/exports API routes to export_transactions"
```

---

### Task 7: Update `ExportTab.tsx`

**Files:**
- Modify: `app/production/components/ExportTab.tsx`

**Interfaces:**
- Consumes: `ExportTransaction` shape from Task 2/6 (the route now returns this shape from `/api/production/exports`).
- Produces: nothing consumed by later tasks — UI leaf.

- [ ] **Step 1: Replace the `BatchExport` interface**

Replace lines 14-36:
```ts
interface ExportTransactionRow {
  id: string;
  batch_id: string;
  channel: ExportChannel;
  recipient_id: string | null;
  recipient_name: string | null;
  /** Packaging variant label, e.g. "1/6 Keg" or "Case (24ct)". */
  variant_label: string;
  quantity: number;
  volume_bbl: number;
  notes: string | null;
  /** Total excise tax (USD) across all applicable rates, persisted at export time. */
  total_excise_tax_usd: number;
  status: "invoice_required" | "unpaid" | "paid";
  created_at: string;
  brew_batches: { id: string; beer_name: string; batch_number: number } | null;
}
```
(Drops `product_type`/`unit` in favor of `variant_label`; drops the unused `square_*` fields since nothing in this codebase ever wrote them — confirmed via repo-wide search before this plan was written.)

- [ ] **Step 2: Update `ExportsChannelTab` to read the new shape**

Replace the `ExportsChannelTab` function's prop type and totals computation (currently lines 210-229):
```ts
function ExportsChannelTab({ channel, exports, links, recipes, onLinksChanged }: {
  channel: ExportChannel;
  exports: ExportTransactionRow[];
  links: LinkRow[];
  recipes: Recipe[];
  onLinksChanged: () => void;
}) {
  const [showLinks, setShowLinks] = useState(false);
  const qc = useQueryClient();
  const refreshLinks = () => { qc.invalidateQueries({ queryKey: queryKeys.production.recipeSquareLinks() }); onLinksChanged(); };

  const channelExports = exports.filter(e => e.channel === channel);
  const channelMeta = CHANNEL_TABS.find(c => c.key === channel)!;

  const totalBbl  = channelExports.reduce((s, e) => s + (e.volume_bbl ?? 0), 0);
  const totalGal  = totalBbl * BBL_TO_GAL;
  const totalTax  = channelExports.reduce((s, e) => s + (e.total_excise_tax_usd ?? 0), 0);
```
Remove the now-unused `FEDERAL_EXCISE_RATE_PER_BBL`/`NC_EXCISE_RATE_PER_GAL` module-level constants (lines 65-66) — the tax amounts are always persisted on the row now (`computeExciseTaxBreakdown` runs for every export, so `total_excise_tax_usd` is never null), so the old per-row fallback calculation (`e.federal_excise_tax_usd ?? (e.volume_bbl ?? 0) * FEDERAL_EXCISE_RATE_PER_BBL`) is no longer needed.

- [ ] **Step 3: Update the table body and totals display**

Replace the table `<thead>` (lines 262-276):
```tsx
              <tr className="border-b border-zinc-800 bg-zinc-900/50 text-left">
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Date</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Batch</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Packaging</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500 text-right">Qty</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500 text-right">Gallons</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500 text-right">BBL</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500 text-right">Excise Tax</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Status</th>
                {channel !== "taproom" && <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Recipient</th>}
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Notes</th>
                <th className="px-4 py-2.5" />
              </tr>
```
(Drops the "Fed. Excise"/"NC Excise"/"Square Sync" columns — there's no longer a fixed two-tax split to show separately, and the Square sync columns were dead/never-written; adds a "Status" column for the new `invoice_required`/`unpaid`/`paid` lifecycle.)

Replace the `<tbody>` row rendering (lines 279-318):
```tsx
              {channelExports.map(e => (
                <tr key={e.id} className="border-b border-zinc-800 last:border-0 hover:bg-zinc-900/30">
                  <td className="px-4 py-2.5 text-zinc-400 whitespace-nowrap">{fmt(e.created_at)}</td>
                  <td className="px-4 py-2.5 text-zinc-200">
                    {e.brew_batches ? `#${e.brew_batches.batch_number} ${e.brew_batches.beer_name}` : "—"}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="px-1.5 py-0.5 rounded text-xs bg-zinc-800 text-zinc-300">{e.variant_label}</span>
                  </td>
                  <td className="px-4 py-2.5 text-right text-zinc-200">{e.quantity}</td>
                  <td className="px-4 py-2.5 text-right text-zinc-400">
                    {e.volume_bbl != null ? (e.volume_bbl * BBL_TO_GAL).toFixed(2) : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-right text-zinc-400">
                    {e.volume_bbl != null ? e.volume_bbl.toFixed(4) : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-right text-zinc-400">
                    ${e.total_excise_tax_usd.toFixed(2)}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`text-xs px-1.5 py-0.5 rounded ${
                      e.status === "paid" ? "bg-emerald-900/40 text-emerald-400"
                      : e.status === "unpaid" ? "bg-amber-900/40 text-amber-400"
                      : "bg-zinc-800 text-zinc-400"
                    }`}>
                      {e.status === "invoice_required" ? "Invoice Required" : e.status === "unpaid" ? "Unpaid" : "Paid"}
                    </span>
                  </td>
                  {channel !== "taproom" && <td className="px-4 py-2.5 text-zinc-400">{e.recipient_name ?? "—"}</td>}
                  <td className="px-4 py-2.5 text-zinc-500 text-xs">{e.notes ?? "—"}</td>
                  <td className="px-4 py-2.5">
                    <button onClick={() => remove(e.id)} className="text-xs text-zinc-600 hover:text-red-400">Delete</button>
                  </td>
                </tr>
              ))}
```

Replace the totals summary block (lines 324-337):
```tsx
      {channelExports.length > 0 && totalBbl > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-x-8 gap-y-1 px-3 py-2.5 bg-zinc-900/60 border border-zinc-800 rounded text-xs">
          <span className="text-zinc-500">Total volume</span>
          <span className="text-zinc-300 font-medium tabular-nums">
            {totalGal.toFixed(2)} gal &nbsp;/&nbsp; {totalBbl.toFixed(4)} BBL
          </span>
          <span className="text-zinc-400 font-medium border-t border-zinc-800 pt-1 mt-0.5">Total excise tax</span>
          <span className="text-amber-300 font-semibold tabular-nums border-t border-zinc-800 pt-1 mt-0.5">${totalTax.toFixed(2)}</span>
        </div>
      )}
```

- [ ] **Step 4: Update the root component's query type**

Replace line 354-357:
```ts
  const { data: exports = [] } = useQuery({
    queryKey: queryKeys.production.exports(),
    queryFn: () => fetchJson<ExportTransactionRow[]>("/api/production/exports"),
  });
```

- [ ] **Step 5: Build and lint**

Run: `npm run lint && npm run build`
Expected: fully clean — this is the last file referencing the old `batch_exports`/`BatchExport` shape anywhere in the app.

- [ ] **Step 6: Final repo-wide sweep**

Run: `grep -rn "batch_exports\|BatchExport\b" app lib --include="*.ts" --include="*.tsx"`
Expected: zero matches.

- [ ] **Step 7: Commit**

```bash
git branch --show-current   # confirm NOT main before committing
git add app/production/components/ExportTab.tsx
git commit -m "Update ExportTab to display export_transactions with status lifecycle"
```

---

### Task 8: Manual verification

**Files:** none (verification only).

**Interfaces:**
- Consumes: everything from Tasks 1-7.
- Produces: nothing — final gate before considering Spec 2a done.

- [ ] **Step 1: Verify the migration's status recompute**

Run in the Supabase SQL editor:
```sql
select status, count(*) from brew_batches group by status;
```
Expected: no `archived` rows; any batch that was previously `archived` now shows as `complete` or `packaging`.

- [ ] **Step 2: Verify excise tax rates are seeded**

```sql
select name, unit, rate_usd, is_active from excise_tax_rates order by name;
```
Expected: 2 rows — "Federal Excise Tax" (bbl, 3.50), "NC Excise Tax" (gallon, 0.62), both active.

- [ ] **Step 3: Code-trace a simulated export request (no live write, per the same caution applied in Spec 1 — packaging stock and real batches should not be mutated for verification)**

Read through `app/api/production/cold-storage-export/route.ts` end to end and confirm: for a hypothetical request with 2 line items (one keg size, one can format) against a single batch, the code path produces exactly 2 `export_transactions` rows sharing one `shipment_id`, each with its own `computeExciseTaxBreakdown` result inserted as `export_transaction_taxes` rows (2 tax rows per export_transactions row, since 2 rates are active), and `checkAndCompleteBatch` is called once per distinct batch touched.

- [ ] **Step 4: Verify the manual "Complete" button**

In the dev server, navigate to Production → Brewing → Batch Log, find a batch not yet complete, and confirm the row's action button now reads "Complete" (not "Archive") and its confirm dialog reads "Mark batch ... complete?". Do not click it against a real batch unless you intend to actually complete that batch — this is a real status change with cascading effects (releases tank assignments, cancels open schedule entries).

- [ ] **Step 5: Verify the Export tab loads with the new schema**

Navigate to Production → Export. Confirm the Allocations tab still loads (reads `export_transactions` now for `exported_bbl`, but should show the same `0`/`—` values as before for batches with no exports yet, since the table is empty post-migration). Confirm the Taproom/Distribution/Contract Brewing tabs render with no console errors (they'll show "No ... exports recorded yet." since `export_transactions` starts empty).

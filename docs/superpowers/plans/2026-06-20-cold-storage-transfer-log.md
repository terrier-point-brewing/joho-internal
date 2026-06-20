# Cold Storage + Transfer Log Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make kegging/canning "Record Transfer" produce one `batch_transfers` row per packaging variation (instead of one row with an array buried in jsonb), and introduce a first-class `cold_storage_inventory` table so available finished-goods inventory can be queried by recipe + packaging variation + batch without parsing jsonb.

**Architecture:** One migration adds `cold_storage_inventory` and `packaging_items.requires_label`. The existing `/api/production/transfers` POST handler is refactored so its per-transfer logic (RPC insert, packaging deduction, schedule reconciliation) is extracted into a `processTransferLine()` helper that the route now calls once per packaging-variation line instead of once per request. `TransferModal.tsx` is updated to submit `kegging_lines[]` / `canning_lines[]` arrays (replacing the single `kegging_detail`/`canning_detail` objects) and to add the "Packs" quantity input + blank-can label enforcement the spec requires.

**Tech Stack:** Next.js 16 App Router, TypeScript, Tailwind v4, Supabase Postgres (raw SQL migrations, plpgsql RPC), Supabase JS client.

## Global Constraints

- This repo has **no test runner configured** (`package.json` only has `dev`/`build`/`start`/`lint`). Verification for each task is `npm run lint`, `npm run build`, and a manual check via the dev server. Do not introduce a new test framework.
- Migrations are additive-only — never hand-edit an existing migration file (per `CLAUDE.md`). Always create a new file in `supabase/migrations/`.
- This repo applies migrations directly to the linked Supabase project via `npx supabase db push` — there is no local Supabase stack running (per `AGENTS.md`/`CLAUDE.md`).
- No business logic in `app/api/**` route bodies beyond what's already there — this plan keeps the existing (pre-existing, not newly introduced) pattern of inline logic in `transfers/route.ts` rather than relocating it to `lib/`, since that would be an unrelated refactor outside this spec's scope. Do not move unrelated existing code while doing this.
- `record_batch_transfer` RPC (`supabase/migrations/20260617_schedule_and_transfer_fixes.sql:19-83`) keeps its exact signature — do not modify it. It is safe to call multiple times per request: it releases/recreates tank assignments and updates `brew_batches.status`/`batch_status_history` idempotently (a second call with an unconstrained destination type like `kegging`/`canning` is a no-op on assignments, and the status-history insert only fires `if v_cur_status is distinct from v_new_status`).
- Packaging-deduction and now cold-storage-inventory writes happen **after** the transfer RPC commits and are best-effort (errors logged, not rolled back) — this matches the existing documented pattern at `transfers/route.ts:104-108`. Calling this multiple times per request (once per line) inherits the same non-atomicity the codebase already accepts; this is a deliberate, existing tradeoff, not a regression introduced by this plan.

---

### Task 1: Migration — `cold_storage_inventory` table + `packaging_items.requires_label`

**Files:**
- Create: `supabase/migrations/20260621_cold_storage_inventory.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: table `public.cold_storage_inventory` with columns `id, batch_id, recipe_id, packaging_item_id, variant_label, quantity_on_hand, source_transfer_id, created_at, updated_at`, unique index on `(batch_id, packaging_item_id, variant_label)`; column `public.packaging_items.requires_label boolean not null default false`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260621_cold_storage_inventory.sql`:

```sql
-- Cold Storage + Transfer Log redesign (Spec 1/4): first-class inventory
-- table so Export Bay can query available finished goods grouped by
-- recipe + packaging variation, attributed to source batch, without
-- parsing batch_transfers jsonb. Also adds a blank-can flag so the
-- canning UI can require a label selection for blank-type cans.

create table if not exists public.cold_storage_inventory (
  id                  uuid primary key default gen_random_uuid(),
  batch_id            uuid not null references public.brew_batches(id) on delete cascade,
  recipe_id           uuid references public.recipes(id) on delete set null,
  packaging_item_id   uuid not null references public.packaging_items(id) on delete restrict,
  variant_label       text not null,
  quantity_on_hand    numeric not null default 0,
  source_transfer_id  uuid references public.batch_transfers(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists cold_storage_inventory_batch_idx
  on public.cold_storage_inventory(batch_id);
create index if not exists cold_storage_inventory_packaging_idx
  on public.cold_storage_inventory(packaging_item_id);
create unique index if not exists cold_storage_inventory_batch_variant_idx
  on public.cold_storage_inventory(batch_id, packaging_item_id, variant_label);

alter table public.packaging_items
  add column if not exists requires_label boolean not null default false;
```

- [ ] **Step 2: Apply the migration and verify**

Run: `npx supabase db push`

Verify with a read query (Supabase SQL editor or `psql`):
```sql
select column_name, data_type from information_schema.columns
where table_name = 'cold_storage_inventory' order by ordinal_position;

select column_name from information_schema.columns
where table_name = 'packaging_items' and column_name = 'requires_label';
```
Expected: `cold_storage_inventory` has the 9 columns listed above; `packaging_items` has `requires_label`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260621_cold_storage_inventory.sql
git commit -m "Add cold_storage_inventory table and packaging_items.requires_label"
```

---

### Task 2: TypeScript types

**Files:**
- Modify: `app/production/types.ts:29-47` (PackagingItem)
- Modify: `app/production/types.ts:83-103` (BatchTransfer)

**Interfaces:**
- Consumes: nothing new from Task 1 beyond the migrated columns.
- Produces: `PackagingItem.requires_label: boolean`; `ColdStorageInventory` interface; narrowed `BatchTransfer.kegging_detail`/`canning_detail` per-variation shapes used by Task 3 and Task 4.

- [ ] **Step 1: Add `requires_label` to `PackagingItem`**

In `app/production/types.ts`, modify the `PackagingItem` interface (currently lines 31-47):

```ts
export interface PackagingItem {
  id: string;
  type: PackagingItemType;
  name: string;
  is_default: boolean;
  requires_label: boolean;
  stock_quantity: number;
  unit_cost: number | null;
  volume_fl_oz: number | null;
  can_count: number | null;
  partner_id: string | null;
  supplier_id: string | null;
  /** Joined from contract_brewing_partners */
  contract_brewing_partners?: { company_name: string } | null;
  /** Joined from suppliers */
  suppliers?: { company_name: string } | null;
  created_at: string;
}
```

- [ ] **Step 2: Narrow `BatchTransfer.kegging_detail` / `canning_detail` to single-variation shapes and add `ColdStorageInventory`**

In `app/production/types.ts`, replace the `BatchTransfer` interface (currently lines 83-103):

```ts
export interface BatchTransfer {
  id: string;
  batch_id: string;
  from_tank_id: string | null;
  to_tank_id: string | null;
  volume_bbl: number;
  shrinkage_bbl: number;
  transfer_type: "transfer" | "kegging" | "canning" | "export" | "conversion" | "brewing";
  notes: string | null;
  kegging_detail: {
    packaging_id: string;
    name: string;
    volume_fl_oz: number | null;
    quantity: number;
    variant_label: string;
  } | null;
  canning_detail: (
    | { format: "case"; tray_packaging_id: string; can_packaging_id: string; lid_packaging_id: string | null; paktech_packaging_id: string | null; label_packaging_id: string | null; cans_per_case: number; quantity: number; variant_label: string }
    | { format: "pack"; paktech_packaging_id: string; can_packaging_id: string; lid_packaging_id: string | null; label_packaging_id: string | null; cans_per_pack: number; quantity: number; variant_label: string }
    | { format: "loose"; can_packaging_id: string; lid_packaging_id: string | null; label_packaging_id: string | null; quantity: number; variant_label: string }
  ) | null;
  export_detail: {
    items: { source_transfer_id: string; product_label: string; product_type: "keg" | "can"; quantity: number }[];
  } | null;
  transferred_at: string;
  to_batch_id: string | null;
  from_tank?: { id: string; name: string; type: EquipmentType } | null;
  to_tank?:   { id: string; name: string; type: EquipmentType } | null;
  to_batch?:  { id: string; beer_name: string; batch_number: string | null } | null;
  created_by_profile?: { email: string } | null;
}

export interface ColdStorageInventory {
  id: string;
  batch_id: string;
  recipe_id: string | null;
  packaging_item_id: string;
  variant_label: string;
  quantity_on_hand: number;
  source_transfer_id: string | null;
  created_at: string;
  updated_at: string;
}
```

- [ ] **Step 3: Verify it compiles**

Run: `npm run build`
Expected: build fails at this point (Task 3/4 not done yet) only on `transfers/route.ts` and `TransferModal.tsx` references to the old `kegging_detail.kegs`/`canning_detail.total_cans` shapes — confirm the failures are limited to those two files, which Tasks 3-4 fix next. If errors appear anywhere else, stop and investigate before continuing.

- [ ] **Step 4: Commit**

```bash
git add app/production/types.ts
git commit -m "Narrow BatchTransfer kegging/canning detail types to per-variation shape"
```

---

### Task 3: Refactor `/api/production/transfers` to record one row per packaging variation

**Files:**
- Modify: `app/api/production/transfers/route.ts` (full rewrite of the `POST` handler body; `GET` is unchanged)

**Interfaces:**
- Consumes: `ColdStorageInventory` type (Task 2, for documentation/shape only — route uses raw Supabase calls, not the TS type, since it's server-side).
- Produces: POST request shape:
  ```ts
  {
    batch_id: string;
    from_tank_id: string | null;
    to_tank_id: string | null;
    transfer_type: "transfer" | "kegging" | "canning" | "conversion";
    shrinkage_bbl?: number;          // total shrinkage for the whole event (kegging/canning only)
    volume_bbl?: number;             // required when transfer_type === "transfer"; ignored/recomputed for kegging/canning
    notes?: string | null;
    kegging_lines?: { packaging_id: string; quantity: number }[];
    canning_lines?: (
      | { format: "case"; tray_packaging_id: string; can_packaging_id: string; lid_packaging_id: string | null; paktech_packaging_id: string | null; label_packaging_id: string | null; quantity: number }
      | { format: "pack"; paktech_packaging_id: string; can_packaging_id: string; lid_packaging_id: string | null; label_packaging_id: string | null; quantity: number }
      | { format: "loose"; can_packaging_id: string; lid_packaging_id: string | null; label_packaging_id: string | null; quantity: number }
    )[];
  }
  ```
  Response shape (unchanged at the top level, `transfer` becomes `transfers: [...]`):
  ```ts
  { transfers: BatchTransferRow[]; schedule_update: ScheduleUpdateEntry[] }
  ```
  This response shape change is consumed by Task 4 (`TransferModal.tsx`'s `onDone` handler).

- [ ] **Step 1: Read the full current file for reference**

Run: `cat -n app/api/production/transfers/route.ts` and keep it open — Steps 2-4 replace specific regions of it, the rest (GET handler, lines 1-40; the destination-departure/partial-transfer logic, lines 420-613) is reused verbatim inside the new per-line helper.

- [ ] **Step 2: Extract a `processTransferLine` helper above the `POST` export**

In `app/api/production/transfers/route.ts`, after the imports (after line 5) and before `export async function GET`, add:

```ts
import { SupabaseClient } from "@supabase/supabase-js";

type ScheduleUpdateEntry = { action: string; entry_id: string; equipment_name?: string; was_deviation?: boolean };

interface TransferLineInput {
  batch_id: string;
  from_tank_id: string | null;
  to_tank_id: string | null;
  volume_bbl: number;
  shrinkage_bbl: number;
  transfer_type: string;
  notes: string | null;
  kegging_detail: { packaging_id: string; name: string; volume_fl_oz: number | null; quantity: number; variant_label: string } | null;
  canning_detail: Record<string, unknown> | null;
  created_by: string | null;
  recipe_id: string | null;
}

/**
 * Records exactly one batch_transfers row plus its downstream side effects
 * (packaging deduction, schedule reconciliation, cold-storage inventory).
 * Called once per packaging variation when transfer_type is kegging/canning,
 * or once total for plain transfers/conversions. Side effects after the RPC
 * insert are best-effort (logged, not rolled back) — same convention the
 * pre-existing packaging-deduction code already used.
 */
async function processTransferLine(
  supabase: SupabaseClient,
  line: TransferLineInput
): Promise<{ transfer: Record<string, unknown>; scheduleUpdate: ScheduleUpdateEntry[] }> {
  const { batch_id, from_tank_id, to_tank_id, volume_bbl, shrinkage_bbl, transfer_type, notes, kegging_detail, canning_detail, created_by, recipe_id } = line;

  const { data: transfer, error } = await supabase
    .rpc("record_batch_transfer", {
      p_batch_id:       batch_id,
      p_from_tank_id:   from_tank_id  || null,
      p_to_tank_id:     to_tank_id    || null,
      p_volume_bbl:     volume_bbl,
      p_shrinkage_bbl:  shrinkage_bbl ?? 0,
      p_transfer_type:  transfer_type ?? "transfer",
      p_notes:          notes         || null,
      p_kegging_detail: kegging_detail ?? null,
      p_canning_detail: canning_detail ?? null,
      p_created_by:     created_by ?? null,
    })
    .single();

  if (error) {
    const status = error.message.includes("already occupied") ? 409 : 500;
    throw Object.assign(new Error(error.message), { status });
  }

  const transferRow = transfer as { id: string };

  // ── Packaging deduction + cold storage inventory ─────────────────────────
  try {
    if (transfer_type === "kegging" && kegging_detail) {
      const { packaging_id, quantity, variant_label } = kegging_detail;
      if (packaging_id && quantity) {
        const { data: pkg } = await supabase.from("packaging_items").select("stock_quantity").eq("id", packaging_id).single();
        if (pkg) {
          const newQty = Number(pkg.stock_quantity) - quantity;
          await supabase.from("packaging_items").update({ stock_quantity: newQty }).eq("id", packaging_id);
          await supabase.from("packaging_stock_adjustments").insert({
            packaging_item_id: packaging_id, quantity: -quantity, type: "used",
            note: `Kegging — batch ${batch_id}`, batch_transfer_id: transferRow.id,
            cost_per_unit: null, total_value_change: null,
          });
        }
        await upsertColdStorageInventory(supabase, {
          batch_id, recipe_id, packaging_item_id: packaging_id, variant_label,
          quantity_delta: quantity, source_transfer_id: transferRow.id,
        });
      }
    }

    if (transfer_type === "canning" && canning_detail) {
      const cd = canning_detail as {
        format: "case" | "pack" | "loose";
        can_packaging_id?: string; lid_packaging_id?: string | null;
        paktech_packaging_id?: string; tray_packaging_id?: string; label_packaging_id?: string | null;
        cans_per_case?: number; cans_per_pack?: number; quantity: number; variant_label: string;
      };
      const cansPerUnit = cd.format === "case" ? (cd.cans_per_case ?? 0) : cd.format === "pack" ? (cd.cans_per_pack ?? 0) : 1;
      const totalCans = cd.quantity * cansPerUnit;

      const deductions: { id: string | null | undefined; qty: number; label: string }[] = [
        { id: cd.can_packaging_id,   qty: totalCans, label: "cans" },
        { id: cd.lid_packaging_id,   qty: totalCans, label: "lids" },
        { id: cd.label_packaging_id, qty: totalCans, label: "labels" },
      ];
      if (cd.format === "case") deductions.push({ id: cd.tray_packaging_id, qty: cd.quantity, label: "trays" });
      if (cd.format === "pack")  deductions.push({ id: cd.paktech_packaging_id, qty: cd.quantity, label: "paktechs" });

      for (const d of deductions) {
        if (!d.id || !d.qty) continue;
        const { data: pkg } = await supabase.from("packaging_items").select("stock_quantity").eq("id", d.id).single();
        if (pkg) {
          const newQty = Number(pkg.stock_quantity) - d.qty;
          await supabase.from("packaging_items").update({ stock_quantity: newQty }).eq("id", d.id);
          await supabase.from("packaging_stock_adjustments").insert({
            packaging_item_id: d.id, quantity: -d.qty, type: "used",
            note: `Canning (${d.label}) — batch ${batch_id}`, batch_transfer_id: transferRow.id,
            cost_per_unit: null, total_value_change: null,
          });
        }
      }

      if (cd.can_packaging_id) {
        await upsertColdStorageInventory(supabase, {
          batch_id, recipe_id, packaging_item_id: cd.can_packaging_id, variant_label: cd.variant_label,
          quantity_delta: cd.quantity, source_transfer_id: transferRow.id,
        });
      }
    }
  } catch (deductionErr) {
    console.error("[transfers] Packaging deduction / cold storage update failed (transfer committed):", deductionErr);
  }

  // ── Schedule reconciliation ───────────────────────────────────────────────
  const scheduleUpdate = await reconcileSchedule(supabase, { batch_id, from_tank_id, to_tank_id, volume_bbl });

  return { transfer, scheduleUpdate };
}

async function upsertColdStorageInventory(
  supabase: SupabaseClient,
  args: { batch_id: string; recipe_id: string | null; packaging_item_id: string; variant_label: string; quantity_delta: number; source_transfer_id: string }
) {
  const { batch_id, recipe_id, packaging_item_id, variant_label, quantity_delta, source_transfer_id } = args;
  const { data: existing } = await supabase
    .from("cold_storage_inventory")
    .select("id, quantity_on_hand")
    .eq("batch_id", batch_id)
    .eq("packaging_item_id", packaging_item_id)
    .eq("variant_label", variant_label)
    .maybeSingle();

  if (existing) {
    await supabase
      .from("cold_storage_inventory")
      .update({
        quantity_on_hand: Number(existing.quantity_on_hand) + quantity_delta,
        source_transfer_id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id);
  } else {
    await supabase.from("cold_storage_inventory").insert({
      batch_id, recipe_id, packaging_item_id, variant_label,
      quantity_on_hand: quantity_delta, source_transfer_id,
    });
  }
}
```

- [ ] **Step 3: Move the existing schedule-reconciliation block into `reconcileSchedule()`**

Still in `app/api/production/transfers/route.ts`, take the existing schedule-reconciliation code that currently lives inline in `POST` (the block from `const RECONCILE_TYPES = new Set(...)` through the end of the `if (from_tank_id) { ... }` partial-transfer block, i.e. the current lines 201-613) and move it, unmodified, into a new function:

```ts
async function reconcileSchedule(
  supabase: SupabaseClient,
  { batch_id, from_tank_id, to_tank_id, volume_bbl }: { batch_id: string; from_tank_id: string | null; to_tank_id: string | null; volume_bbl: number }
): Promise<ScheduleUpdateEntry[]> {
  const RECONCILE_TYPES = new Set(["brewhouse", "fermenter", "brite", "kegging", "canning"]);
  // ... function body continues exactly as today's route.ts ...
  return scheduleUpdate;
}
```

This function's body is a verbatim cut of the **current** `route.ts` lines 201-613 (everything from the `const RECONCILE_TYPES = new Set(...)` declaration through the closing `}` of the final `if (from_tank_id) { ... }` partial-transfer block, right before the old `return NextResponse.json(...)` line). Cut that exact text block out of the current `POST` function and paste it as the body of `reconcileSchedule`, then delete the now-redundant `const RECONCILE_TYPES = ...` line you just typed above (it was shown only to anchor where the pasted block starts) — the real block already begins with that declaration.

Do not alter any logic inside the moved block. It only ever references `batch_id`, `from_tank_id`, `to_tank_id`, `volume_bbl`, `supabase`, and `today` (a local `const today = new Date().toISOString().split("T")[0];` defined inside the block itself) — it never references `shrinkage_bbl`, `transfer_type`, `notes`, `kegging_detail`, or `canning_detail`, so none of those need to be threaded into the new function signature. End the function with `return scheduleUpdate;` (the array the moved block already builds via `scheduleUpdate.push(...)` calls).

Place this function definition directly after `processTransferLine` and before `upsertColdStorageInventory`, or after it — order between the three helpers doesn't matter since none call each other except `processTransferLine` calling both.

- [ ] **Step 4: Rewrite the `POST` export to build lines and loop**

Replace the current `export async function POST` body (currently lines 42-616) with:

```ts
export async function POST(req: NextRequest) {
  try { await requireRole("brewer"); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { data: { user: currentUser } } = await supabase.auth.getUser();

  const body = await req.json();
  const {
    batch_id,
    from_tank_id,
    to_tank_id,
    transfer_type,
    notes,
    kegging_lines,
    canning_lines,
  } = body as {
    batch_id: string;
    from_tank_id: string | null;
    to_tank_id: string | null;
    transfer_type: "transfer" | "kegging" | "canning" | "conversion";
    notes: string | null;
    volume_bbl?: number;
    shrinkage_bbl?: number;
    kegging_lines?: { packaging_id: string; quantity: number }[];
    canning_lines?: Record<string, unknown>[];
  };

  const { data: batchRow } = await supabase.from("brew_batches").select("recipe_id").eq("id", batch_id).single();
  const recipe_id: string | null = batchRow?.recipe_id ?? null;

  // ── Build one line per packaging variation (or a single line for plain transfers/conversions) ──
  type Line = { volume_bbl: number; shrinkage_bbl: number; kegging_detail: TransferLineInput["kegging_detail"]; canning_detail: TransferLineInput["canning_detail"] };
  const lines: Line[] = [];
  const totalShrinkage = Number(body.shrinkage_bbl ?? 0);

  if (transfer_type === "kegging" && kegging_lines?.length) {
    const pkgIds = kegging_lines.map((l) => l.packaging_id);
    const { data: pkgRows } = await supabase.from("packaging_items").select("id, name, volume_fl_oz").in("id", pkgIds);
    const pkgMap = new Map((pkgRows ?? []).map((p) => [p.id, p]));
    const totalVolume = kegging_lines.reduce((sum, l) => {
      const pkg = pkgMap.get(l.packaging_id);
      return sum + (pkg?.volume_fl_oz ? (l.quantity * pkg.volume_fl_oz) / 31 / 128 : 0); // BBL_TO_FL_OZ inlined; see note below
      }, 0);
    let allocatedShrinkage = 0;
    kegging_lines.forEach((l, idx) => {
      const pkg = pkgMap.get(l.packaging_id);
      const lineVolume = pkg?.volume_fl_oz ? (l.quantity * pkg.volume_fl_oz) / 31 / 128 : 0;
      const isLast = idx === kegging_lines.length - 1;
      const shrinkShare = isLast ? totalShrinkage - allocatedShrinkage : Math.round((totalVolume > 0 ? (lineVolume / totalVolume) * totalShrinkage : 0) * 1000) / 1000;
      allocatedShrinkage += shrinkShare;
      lines.push({
        volume_bbl: lineVolume,
        shrinkage_bbl: shrinkShare,
        kegging_detail: { packaging_id: l.packaging_id, name: pkg?.name ?? "", volume_fl_oz: pkg?.volume_fl_oz ?? null, quantity: l.quantity, variant_label: pkg?.name ?? "Keg" },
        canning_detail: null,
      });
    });
  } else if (transfer_type === "canning" && canning_lines?.length) {
    const totalCanUnits = canning_lines.reduce((sum, l) => sum + Number((l as { quantity: number }).quantity), 0);
    let allocatedShrinkage = 0;
    for (let idx = 0; idx < canning_lines.length; idx++) {
      const raw = canning_lines[idx] as { format: "case" | "pack" | "loose"; quantity: number; can_packaging_id: string; cans_per_case?: number; cans_per_pack?: number };
      const { data: canPkg } = await supabase.from("packaging_items").select("volume_fl_oz").eq("id", raw.can_packaging_id).single();
      const cansPerUnit = raw.format === "case" ? (raw.cans_per_case ?? 0) : raw.format === "pack" ? (raw.cans_per_pack ?? 0) : 1;
      const lineVolume = canPkg?.volume_fl_oz ? (raw.quantity * cansPerUnit * canPkg.volume_fl_oz) / 31 / 128 : 0;
      const isLast = idx === canning_lines.length - 1;
      const shrinkShare = isLast ? totalShrinkage - allocatedShrinkage : Math.round((totalCanUnits > 0 ? (raw.quantity / totalCanUnits) * totalShrinkage : 0) * 1000) / 1000;
      allocatedShrinkage += shrinkShare;
      const variantLabel = raw.format === "case" ? `Case (${raw.cans_per_case}ct)` : raw.format === "pack" ? `${raw.cans_per_pack}-Pack` : "Loose Can";
      lines.push({
        volume_bbl: lineVolume,
        shrinkage_bbl: shrinkShare,
        kegging_detail: null,
        canning_detail: { ...raw, variant_label: variantLabel },
      });
    }
  } else {
    lines.push({
      volume_bbl: Number(body.volume_bbl ?? 0),
      shrinkage_bbl: totalShrinkage,
      kegging_detail: null,
      canning_detail: null,
    });
  }

  const totalVolumeForCapacityCheck = lines.reduce((s, l) => s + l.volume_bbl, 0);

  // Capacity guard: reject before writing anything if destination is a
  // constrained tank and the total transfer volume exceeds its capacity_bbl.
  if (to_tank_id && totalVolumeForCapacityCheck > 0) {
    const { data: destTank } = await supabase.from("equipment").select("capacity_bbl, type").eq("id", to_tank_id).single();
    const UNCONSTRAINED = new Set(["kegging", "canning", "cold_storage", "backlog", "loading_bay", "export_bay"]);
    if (destTank && !UNCONSTRAINED.has(destTank.type) && destTank.capacity_bbl != null && totalVolumeForCapacityCheck > destTank.capacity_bbl) {
      return NextResponse.json(
        { error: `Transfer volume (${totalVolumeForCapacityCheck} BBL) exceeds destination capacity (${destTank.capacity_bbl} BBL).` },
        { status: 422 }
      );
    }
  }

  const transfers: Record<string, unknown>[] = [];
  const allScheduleUpdates: ScheduleUpdateEntry[] = [];

  for (const line of lines) {
    try {
      const { transfer, scheduleUpdate } = await processTransferLine(supabase, {
        batch_id, from_tank_id, to_tank_id,
        volume_bbl: line.volume_bbl, shrinkage_bbl: line.shrinkage_bbl,
        transfer_type: transfer_type ?? "transfer", notes: notes || null,
        kegging_detail: line.kegging_detail, canning_detail: line.canning_detail,
        created_by: currentUser?.id ?? null, recipe_id,
      });
      transfers.push(transfer);
      allScheduleUpdates.push(...scheduleUpdate);
    } catch (e) {
      const status = (e as { status?: number }).status ?? 500;
      return NextResponse.json(
        { error: (e as Error).message, transfers_committed: transfers.length },
        { status }
      );
    }
  }

  return NextResponse.json({ transfers, schedule_update: allScheduleUpdates }, { status: 201 });
}
```

Note on `BBL_TO_FL_OZ`: the route runs server-side and doesn't import from `lib/constants/production.ts` today (the constant `BBL_TO_FL_OZ = 31 * 128 = 3968` lives there per `TransferModal.tsx:8`). Replace the inlined `/ 31 / 128` divisions above with a proper import: add `import { BBL_TO_FL_OZ } from "@/lib/constants/production";` to the top of `route.ts` and use `(l.quantity * pkg.volume_fl_oz) / BBL_TO_FL_OZ` instead of `/ 31 / 128`. Do this in this step, not as a follow-up.

- [ ] **Step 5: Build and lint**

Run: `npm run lint && npm run build`
Expected: both pass with zero errors related to `transfers/route.ts`.

- [ ] **Step 6: Commit**

```bash
git add app/api/production/transfers/route.ts
git commit -m "Record one batch_transfers row per packaging variation, add cold storage inventory upserts"
```

---

### Task 4: Update `TransferModal.tsx` — multi-line submission, Packs field, blank-can label enforcement

**Files:**
- Modify: `app/production/components/TransferModal.tsx`

**Interfaces:**
- Consumes: POST `/api/production/transfers` request shape from Task 3 (`kegging_lines`, `canning_lines`); `PackagingItem.requires_label` from Task 2.
- Produces: nothing consumed by later tasks in this plan (UI leaf).

- [ ] **Step 1: Add a "Packs" quantity field alongside Cases and Loose Cans**

In `app/production/components/TransferModal.tsx`, add state near the existing `cases`/`looseCans` state (around line 134-135):

```ts
  const [cases,     setCases]     = useState("");
  const [packs,     setPacks]     = useState("");
  const [looseCans, setLooseCans] = useState("0");
```

- [ ] **Step 2: Compute total cans including packs, and derive `cansPerPack`**

Near the existing `selectedTray`/`cansPerCase` computation (around line 160-162), add:

```ts
  const selectedTray   = packaging.find((p) => p.id === trayId);
  const cansPerCase    = selectedTray?.can_count ?? 0;
  const selectedPaktech = packaging.find((p) => p.id === paktechId);
  const cansPerPack    = selectedPaktech?.can_count ?? 0;
  const selectedCan    = packaging.find((p) => p.id === canId);
```

Update the `drawBbl` computation for `showCanDetail` (currently around line 177-180):

```ts
  } else if (showCanDetail) {
    const totalCans = (parseInt(cases) || 0) * cansPerCase + (parseInt(packs) || 0) * cansPerPack + (parseInt(looseCans) || 0);
    const canVol    = selectedCan?.volume_fl_oz ?? 0;
    drawBbl = (totalCans * canVol) / BBL_TO_FL_OZ;
  }
```

- [ ] **Step 3: Require a label when the selected can has `requires_label = true`**

Add a derived flag near `selectedCan` (Step 2 location):

```ts
  const canRequiresLabel = selectedCan?.requires_label ?? false;
```

In the Can-detail JSX block (around line 556-561), change the Label field to show it's conditionally required and block submission without it:

```tsx
              <Field label={canRequiresLabel ? "Label (required — blank can selected)" : "Label"} required={canRequiresLabel}>
                <select className="inp" value={labelId} required={canRequiresLabel} onChange={(e) => setLabelId(e.target.value)}>
                  <option value="">— select —</option>
                  {labels.map((c) => <option key={c.id} value={c.id}>{pkgLabel(c)}{c.is_default ? " ★" : ""}</option>)}
                </select>
              </Field>
```

In `handleSubmit`, before building `canning_lines` (right after the `if (showKegDetail)` / `else if (showCanDetail)` branch point, before the existing capacity-guard check), add a client-side guard:

```ts
      if (showCanDetail && canRequiresLabel && !labelId) {
        alert("This can requires a label — please select one before recording the transfer.");
        return;
      }
```

- [ ] **Step 4: Add a "Packs" input to the JSX, next to Cases and Loose cans**

Replace the existing two-field grid (currently lines 563-572) with a three-field grid:

```tsx
            {(cansPerCase > 0 || cansPerPack > 0) && (
              <div className="grid grid-cols-3 gap-3">
                <Field label={`Cases (${cansPerCase} cans each)`}>
                  <input type="number" min="0" className="inp" placeholder="0" value={cases} onChange={(e) => setCases(e.target.value)} />
                </Field>
                <Field label={`Packs (${cansPerPack} cans each)`}>
                  <input type="number" min="0" className="inp" placeholder="0" value={packs} onChange={(e) => setPacks(e.target.value)} />
                </Field>
                <Field label="Loose cans">
                  <input type="number" min="0" className="inp" placeholder="0" value={looseCans} onChange={(e) => setLooseCans(e.target.value)} />
                </Field>
              </div>
            )}
            <p className="text-xs text-zinc-500">
              Total cans: {(parseInt(cases) || 0) * cansPerCase + (parseInt(packs) || 0) * cansPerPack + (parseInt(looseCans) || 0)} · Draw: {fmtBbl(drawBbl)}
            </p>
```

- [ ] **Step 5: Build `kegging_lines` / `canning_lines` in `handleSubmit` instead of single detail objects**

Replace the existing block that builds `kegging_detail`/`canning_detail` (currently lines 252-284) with:

```ts
      let kegging_lines: { packaging_id: string; quantity: number }[] | undefined;
      let canning_lines: Record<string, unknown>[] | undefined;
      let transfer_type: "transfer" | "kegging" | "canning" = "transfer";

      if (showKegDetail) {
        transfer_type = "kegging";
        kegging_lines = kegLines
          .filter((l) => l.packaging_id && (parseInt(l.quantity) || 0) > 0)
          .map((l) => ({ packaging_id: l.packaging_id, quantity: parseInt(l.quantity) || 0 }));
      } else if (showCanDetail) {
        transfer_type = "canning";
        canning_lines = [];
        const casesQty = parseInt(cases) || 0;
        const packsQty = parseInt(packs) || 0;
        const looseQty = parseInt(looseCans) || 0;
        const shared = {
          can_packaging_id: canId,
          lid_packaging_id: lidId || null,
          label_packaging_id: labelId || null,
        };
        if (casesQty > 0) canning_lines.push({ ...shared, format: "case", tray_packaging_id: trayId, paktech_packaging_id: paktechId || null, cans_per_case: cansPerCase, quantity: casesQty });
        if (packsQty > 0) canning_lines.push({ ...shared, format: "pack", paktech_packaging_id: paktechId, cans_per_pack: cansPerPack, quantity: packsQty });
        if (looseQty > 0) canning_lines.push({ ...shared, format: "loose", quantity: looseQty });
      }
```

- [ ] **Step 6: Update the fetch body and `onDone` call to match the new response shape**

Replace the existing `fetch` call and response handling (currently lines 286-304):

```ts
      const res = await fetch("/api/production/transfers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batch_id:      batch.id,
          from_tank_id:  fromTank.id,
          to_tank_id:    effectiveDestId,
          volume_bbl:    drawBbl,
          shrinkage_bbl: shrinkBbl,
          transfer_type,
          notes:         notes || null,
          kegging_lines,
          canning_lines,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      const responseData = await res.json();
      await onDone(responseData);
      onClose();
```

The `onDone` prop type (line 62) already accepts `{ schedule_update?: ... }` — no signature change needed since `transfers: [...]` is additive and unused by callers today; confirm by checking callers in Step 7.

- [ ] **Step 7: Check callers of `onDone` for assumptions about a singular `transfer` key**

Run: `grep -rn "onDone" app/production/ --include="*.tsx"`

Expected: callers only read `response?.schedule_update`, never `response?.transfer` (singular). If any caller reads `.transfer` (singular), update it to read `.transfers[0]` or whichever entry is relevant — but per the current codebase this key is not consumed elsewhere, so no change should be needed. If you find one, fix it now before moving on.

- [ ] **Step 8: Build and lint**

Run: `npm run lint && npm run build`
Expected: both pass.

- [ ] **Step 9: Commit**

```bash
git add app/production/components/TransferModal.tsx
git commit -m "Submit kegging/canning transfers as per-variation lines, add Packs field and blank-can label requirement"
```

---

### Task 5: Manual end-to-end verification

**Files:** none (verification only).

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: nothing — this is the final gate before considering Spec 1 done.

- [ ] **Step 1: Start the dev server**

Run: `npm run dev`

- [ ] **Step 2: Verify multi-variation kegging**

Navigate to `/production/brewing/floorplan` (or wherever the Transfer action is triggered from for a batch in a fermenter/brite tank). Open Transfer on a batch with enough volume, select a kegging destination, add two keg lines (e.g. 1/2 Keg qty 10, 1/6 Keg qty 5) with `+ Add keg type`, and submit.

Expected: success, modal closes. Then query (Supabase SQL editor):
```sql
select transfer_type, volume_bbl, shrinkage_bbl, kegging_detail
from batch_transfers
where batch_id = '<the batch id>'
order by transferred_at desc limit 5;
```
Expected: 2 rows, one per keg size, each `kegging_detail` containing a single `packaging_id`/`quantity`/`variant_label` (not an array).

Then query:
```sql
select packaging_item_id, variant_label, quantity_on_hand from cold_storage_inventory where batch_id = '<the batch id>';
```
Expected: 2 rows, quantities matching what was entered.

- [ ] **Step 3: Verify multi-format canning**

Open Transfer on a batch with a canning destination. Select Can/Lid/PakTech/Tray (and Label if the can requires one), enter values in Cases, Packs, and Loose Cans simultaneously, submit.

Expected: 3 `batch_transfers` rows (one per format) and 3 `cold_storage_inventory` rows (or 3 increments to existing rows if a prior export already created one for that can+format), per the same queries as Step 2.

- [ ] **Step 4: Verify blank-can label enforcement**

In Production → Inventory, set `requires_label = true` on one can packaging item (via SQL if there's no UI toggle yet: `update packaging_items set requires_label = true where id = '<can id>';`). Reopen Transfer, select that can, leave Label blank, attempt to submit.

Expected: client-side alert blocks submission ("This can requires a label..."); selecting a label allows submission to proceed.

- [ ] **Step 5: Verify packaging stock deduction still works**

Before and after a kegging/canning submission, check `packaging_items.stock_quantity` for the relevant items and `packaging_stock_adjustments` rows.

Expected: stock quantities decrease by the correct per-line amounts (not double-deducted, not skipped); one `packaging_stock_adjustments` row per packaging item per line, each `batch_transfer_id` pointing to the correct one of the multiple new `batch_transfers` rows.

- [ ] **Step 6: Verify `batch_exhaustion` view still totals correctly**

```sql
select * from batch_exhaustion where batch_id = '<the batch id>';
```
Expected: `kegged_bbl`/`canned_bbl` equal the sum of the volumes across all the per-variation rows just created (i.e., splitting into multiple rows didn't change the aggregate).

- [ ] **Step 7: Verify existing single-variation submissions still work**

Submit a kegging transfer with only one keg line, and a canning transfer with only Loose Cans filled in (Cases/Packs left at 0). Expected: exactly 1 `batch_transfers` row each, matching pre-existing behavior — confirming no regression for the common case.

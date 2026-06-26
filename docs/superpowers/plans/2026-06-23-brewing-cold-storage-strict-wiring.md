# Spec 10: Brewing/Kegging-Canning + Cold Storage Strict Wiring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace ad-hoc packaging-component assembly + free-text `variant_label` in kegging/canning transfers and cold storage with strict selection from a recipe's declared `recipe_packaging_variations`, and fix the demand-calendar proxy-lookup bug by joining through the real variation model.

**Architecture:** `packaging_variations` gains a server-computed, trigger-maintained `total_volume_fl_oz`. `batch_transfers` gains nullable `variation_id`/`quantity` columns (one row per variation produced) and drops `kegging_detail`/`canning_detail` JSONB. `cold_storage_inventory` is rekeyed from `(batch_id, packaging_item_id, variant_label)` to `(batch_id, variation_id)`. Every downstream consumer (TransferModal, transfers API, demand-calendar, ExportBayTab, cold-storage depletion) is updated to match.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase Postgres (PostgREST), Tailwind v4, TanStack Query.

## Global Constraints

- No test runner exists in this repo — verification is `npm run lint` + `npm run build` + manual REST checks against the live Supabase project (`drlsazatrcrdwaihjmex`) via `.env.local`'s `SUPABASE_SERVICE_ROLE_KEY`.
- Migrations are applied manually: paste SQL into the Supabase Dashboard SQL Editor, then run the `insert into supabase_migrations.schema_migrations(version) values ('<8-digit-date-prefix>') on conflict (version) do nothing;` tracking insert. The agent cannot do this step itself — ask the user to paste and confirm.
- `npm run lint` must be run explicitly and separately from `npm run build` in every task — Turbopack's `npm run build` does not run ESLint.
- `requireRole([...])` is a literal allow-list, not a floor — write routes in this codebase use `requireRole(["brewer"])`.
- Existing `cold_storage_inventory` data and `batch_transfers.kegging_detail`/`canning_detail` rows are disposable test data — no backfill/reconciliation needed, truncation is acceptable.

---

### Task 1: `packaging_variations.total_volume_fl_oz` + cascade trigger

**Files:**
- Create: `supabase/migrations/20260627_variation_total_volume.sql`
- Modify: `lib/production/packagingVariations.ts`
- Modify: `app/api/production/packaging-variations/route.ts`
- Modify: `app/api/production/packaging-variations/[id]/route.ts`
- Modify: `app/production/types.ts` (`PackagingVariation` interface, lines 53-72)

**Interfaces:**
- Produces: `computeTotalVolumeFlOz(supabase, { container_id, format, tray_id, paktech_id }): Promise<number>` exported from `lib/production/packagingVariations.ts` — used by Task 1's own routes and by Task 4 (transfers route doesn't need it directly since it reads the stored column, but keep it exported for reuse).
- Produces: `PackagingVariation.total_volume_fl_oz: number` field, consumed by Task 4 (volume calc) and Task 6 (demand-calendar).

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260627_variation_total_volume.sql

alter table public.packaging_variations
  add column if not exists total_volume_fl_oz numeric;

update public.packaging_variations v
set total_volume_fl_oz = c.volume_fl_oz * coalesce(
  case
    when v.format = 'case' then t.can_count
    when v.format in ('4-pack', '6-pack') then p.can_count
    else 1
  end, 1)
from public.packaging_items c
left join public.packaging_items t on t.id = v.tray_id
left join public.packaging_items p on p.id = v.paktech_id
where c.id = v.container_id;

alter table public.packaging_variations
  alter column total_volume_fl_oz set not null;

create or replace function public.recompute_variation_total_volume() returns trigger as $$
begin
  update public.packaging_variations v
  set total_volume_fl_oz = c.volume_fl_oz * coalesce(
    case
      when v.format = 'case' then t.can_count
      when v.format in ('4-pack', '6-pack') then p.can_count
      else 1
    end, 1)
  from public.packaging_items c
  left join public.packaging_items t on t.id = v.tray_id
  left join public.packaging_items p on p.id = v.paktech_id
  where c.id = v.container_id
    and (v.container_id = new.id or v.tray_id = new.id or v.paktech_id = new.id);
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_recompute_variation_total_volume on public.packaging_items;
create trigger trg_recompute_variation_total_volume
  after update of volume_fl_oz, can_count on public.packaging_items
  for each row execute function public.recompute_variation_total_volume();
```

- [ ] **Step 2: Ask the user to apply the migration**

Paste the SQL above into the Supabase Dashboard SQL Editor for project `drlsazatrcrdwaihjmex`, run it, then run:
```sql
insert into supabase_migrations.schema_migrations (version) values ('20260627') on conflict (version) do nothing;
```
Wait for the user to confirm both ran successfully before continuing.

- [ ] **Step 3: Verify via REST**

```bash
curl -s "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/packaging_variations?select=id,name,total_volume_fl_oz&limit=15" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```
Expected: all 11 seeded rows have a non-null, plausible `total_volume_fl_oz` (e.g. a 12oz 24-count case variation shows `288`).

- [ ] **Step 4: Add the shared compute helper**

In `lib/production/packagingVariations.ts`, add below the existing `validateFormat` export:

```typescript
import type { SupabaseClient } from "@supabase/supabase-js";

export async function computeTotalVolumeFlOz(
  supabase: SupabaseClient,
  { container_id, format, tray_id, paktech_id }: { container_id: string; format: string; tray_id: string | null; paktech_id: string | null }
): Promise<number> {
  const { data: container } = await supabase.from("packaging_items").select("volume_fl_oz").eq("id", container_id).single();
  const containerVolume = container?.volume_fl_oz ?? 0;
  let unitsPerPackage = 1;
  if (format === "case" && tray_id) {
    const { data: tray } = await supabase.from("packaging_items").select("can_count").eq("id", tray_id).single();
    unitsPerPackage = tray?.can_count ?? 1;
  } else if ((format === "4-pack" || format === "6-pack") && paktech_id) {
    const { data: paktech } = await supabase.from("packaging_items").select("can_count").eq("id", paktech_id).single();
    unitsPerPackage = paktech?.can_count ?? 1;
  }
  return containerVolume * unitsPerPackage;
}
```

- [ ] **Step 5: Wire into POST (create) route**

In `app/api/production/packaging-variations/route.ts`, import `computeTotalVolumeFlOz` and insert the computed value:

```typescript
import { PACKAGING_VARIATION_SELECT, validateFormat, computeTotalVolumeFlOz } from "@/lib/production/packagingVariations";
```

Replace the `.insert({...})` block (current lines 44-53) with:

```typescript
  const total_volume_fl_oz = await computeTotalVolumeFlOz(supabase, {
    container_id, format, tray_id: tray_id || null, paktech_id: paktech_id || null,
  });

  const { data, error } = await supabase
    .from("packaging_variations")
    .insert({
      container_id,
      format,
      lid_id: lid_id || null,
      paktech_id: paktech_id || null,
      tray_id: tray_id || null,
      label_id: label_id || null,
      partner_id: partner_id || null,
      name,
      total_volume_fl_oz,
    })
    .select(PACKAGING_VARIATION_SELECT)
    .single();
```

- [ ] **Step 6: Wire into PATCH (update) route**

In `app/api/production/packaging-variations/[id]/route.ts`, same import addition, then replace the `.update({...})` block (current lines 34-44) with:

```typescript
  const total_volume_fl_oz = await computeTotalVolumeFlOz(supabase, {
    container_id, format, tray_id: tray_id || null, paktech_id: paktech_id || null,
  });

  const { data, error } = await supabase
    .from("packaging_variations")
    .update({
      container_id,
      format,
      lid_id: lid_id || null,
      paktech_id: paktech_id || null,
      tray_id: tray_id || null,
      label_id: label_id || null,
      partner_id: partner_id || null,
      name,
      is_active: is_active ?? true,
      total_volume_fl_oz,
    })
    .eq("id", id)
    .select(PACKAGING_VARIATION_SELECT)
    .single();
```

- [ ] **Step 7: Update the TypeScript type**

In `app/production/types.ts`, add to the `PackagingVariation` interface (after `name: string;`):

```typescript
  total_volume_fl_oz: number;
```

- [ ] **Step 8: Verify**

```bash
npm run lint
npm run build
```
Expected: both clean (0 errors).

- [ ] **Step 9: Commit**

```bash
git add supabase/migrations/20260627_variation_total_volume.sql lib/production/packagingVariations.ts app/api/production/packaging-variations/route.ts app/api/production/packaging-variations/[id]/route.ts app/production/types.ts
git commit -m "feat: compute and store packaging_variations.total_volume_fl_oz"
```

---

### Task 2: Rekey `batch_transfers` and `cold_storage_inventory`

**Files:**
- Create: `supabase/migrations/20260628_strict_packaging_rekey.sql`
- Modify: `app/production/types.ts` (`BatchTransfer`, `ColdStorageInventory`, `AvailableInventoryLine` interfaces)

**Interfaces:**
- Produces: `batch_transfers.variation_id: uuid | null`, `batch_transfers.quantity: numeric | null` — consumed by Task 4, 5, 6.
- Produces: `cold_storage_inventory.variation_id: uuid` (replaces `packaging_item_id`+`variant_label`) — consumed by Task 3, 4, 7.
- Produces: `record_batch_transfer(p_variation_id uuid, p_quantity numeric, ...)` RPC signature (replaces `p_kegging_detail`/`p_canning_detail`) — consumed by Task 4.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260628_strict_packaging_rekey.sql

alter table public.batch_transfers
  add column if not exists variation_id uuid references public.packaging_variations(id) on delete restrict,
  add column if not exists quantity numeric;

alter table public.batch_transfers
  drop column if exists kegging_detail,
  drop column if exists canning_detail;

truncate table public.cold_storage_inventory;

alter table public.cold_storage_inventory
  drop column if exists packaging_item_id,
  drop column if exists variant_label,
  add column if not exists variation_id uuid references public.packaging_variations(id) on delete restrict;

alter table public.cold_storage_inventory
  alter column variation_id set not null;

drop index if exists cold_storage_inventory_packaging_idx;
drop index if exists cold_storage_inventory_batch_variant_idx;
create index if not exists cold_storage_inventory_variation_idx on public.cold_storage_inventory(variation_id);
create unique index if not exists cold_storage_inventory_batch_variation_idx
  on public.cold_storage_inventory(batch_id, variation_id);

create or replace function public.record_batch_transfer(
  p_batch_id       uuid,
  p_from_tank_id   uuid,
  p_to_tank_id     uuid,
  p_volume_bbl     numeric,
  p_shrinkage_bbl  numeric  default 0,
  p_transfer_type  text     default 'transfer',
  p_notes          text     default null,
  p_variation_id   uuid     default null,
  p_quantity       numeric  default null,
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
    transfer_type, notes, variation_id, quantity, created_by
  ) values (
    p_batch_id, p_from_tank_id, p_to_tank_id, p_volume_bbl, coalesce(p_shrinkage_bbl, 0),
    coalesce(p_transfer_type, 'transfer'), p_notes, p_variation_id, p_quantity,
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
```

- [ ] **Step 2: Ask the user to apply the migration**

Same dashboard process as Task 1, with tracking insert `('20260628')`. Confirm before continuing — this truncates live `cold_storage_inventory` data, so double-check the user is ready for that (per the spec, already confirmed acceptable, but reconfirm at execution time since it's destructive).

- [ ] **Step 3: Verify via REST**

```bash
curl -s "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/cold_storage_inventory?select=id&limit=1" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```
Expected: `[]` (table truncated, no `packaging_item_id`/`variant_label` columns referenced anywhere).

- [ ] **Step 4: Update `BatchTransfer` type**

In `app/production/types.ts`, replace the `kegging_detail`/`canning_detail` fields (current lines ~128-135) with:

```typescript
  variation_id: string | null;
  quantity: number | null;
  packaging_variations?: { id: string; name: string } | null;
```

Remove the now-unused inline union types for `kegging_detail`/`canning_detail` entirely.

- [ ] **Step 5: Update `ColdStorageInventory` and `AvailableInventoryLine` types**

Replace `ColdStorageInventory` (lines 151-161):

```typescript
export interface ColdStorageInventory {
  id: string;
  batch_id: string;
  recipe_id: string | null;
  variation_id: string;
  quantity_on_hand: number;
  source_transfer_id: string | null;
  created_at: string;
  updated_at: string;
}
```

Replace `AvailableInventoryLine` (lines 144-149):

```typescript
export interface AvailableInventoryLine {
  recipe_id: string;
  variation_id: string;
  variation_name: string;
  quantity_on_hand: number;
}
```

- [ ] **Step 6: Verify**

```bash
npm run lint
npm run build
```
Expected: errors in `transfers/route.ts`, `coldStorageDepletion.ts`, `coldStorage.ts`, `ExportBayTab.tsx`, `demand-calendar/route.ts` referencing the now-removed fields — this is expected, Tasks 3-7 fix them. Confirm the *only* errors are in those files (no surprise breakage elsewhere).

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260628_strict_packaging_rekey.sql app/production/types.ts
git commit -m "feat: rekey batch_transfers and cold_storage_inventory to packaging_variations"
```

---

### Task 3: Rekey `coldStorageDepletion.ts`

**Files:**
- Modify: `lib/production/coldStorageDepletion.ts`

**Interfaces:**
- Consumes: `cold_storage_inventory.variation_id` (Task 2).
- Produces: `ColdStorageKey = { recipeId: string; variationId: string }`, `getAvailableColdStorageQuantity(supabase, key): Promise<number>`, `depleteColdStorageInventory(supabase, key & { quantity: number }): Promise<{ batchId: string; depletedQty: number }[]>` — consumed by Task 7.

- [ ] **Step 1: Rewrite the file**

```typescript
import { SupabaseClient } from "@supabase/supabase-js";

interface ColdStorageKey {
  recipeId: string;
  variationId: string;
}

/**
 * Sums quantity_on_hand across every cold_storage_inventory row matching
 * the given recipe/variation — the Export Bay's "how much can I ship" check.
 * Callers reject the request themselves (this returns the raw number, not
 * a NextResponse) so both the regular Ship route and the ad-hoc route can
 * phrase their own "requested X, available Y" message.
 */
export async function getAvailableColdStorageQuantity(
  supabase: SupabaseClient,
  { recipeId, variationId }: ColdStorageKey
): Promise<number> {
  const { data, error } = await supabase
    .from("cold_storage_inventory")
    .select("quantity_on_hand")
    .eq("recipe_id", recipeId)
    .eq("variation_id", variationId);
  if (error) throw new Error(error.message);
  return (data ?? []).reduce((s, r) => s + Number(r.quantity_on_hand), 0);
}

/**
 * Depletes cold_storage_inventory oldest-row-first for the given
 * recipe/variation, up to `quantity` units total. Deletes a row once it
 * hits ~0, otherwise decrements it. Returns one entry per row touched —
 * since (batch_id, variation_id) is unique, each entry already belongs to
 * exactly one batch and needs no further aggregation by the caller.
 *
 * Caller must have already verified `quantity` does not exceed the total
 * available (via getAvailableColdStorageQuantity) — this function does not
 * re-check and will simply deplete everything it finds if asked for more.
 */
export async function depleteColdStorageInventory(
  supabase: SupabaseClient,
  { recipeId, variationId, quantity }: ColdStorageKey & { quantity: number }
): Promise<{ batchId: string; depletedQty: number }[]> {
  const { data: rows, error } = await supabase
    .from("cold_storage_inventory")
    .select("id, batch_id, quantity_on_hand, created_at")
    .eq("recipe_id", recipeId)
    .eq("variation_id", variationId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);

  const depleted: { batchId: string; depletedQty: number }[] = [];
  let qtyLeft = quantity;
  for (const row of rows ?? []) {
    if (qtyLeft <= 0) break;
    const take = Math.min(Number(row.quantity_on_hand), qtyLeft);
    const newQty = Number(row.quantity_on_hand) - take;
    if (newQty <= 0.0001) {
      await supabase.from("cold_storage_inventory").delete().eq("id", row.id);
    } else {
      await supabase.from("cold_storage_inventory").update({ quantity_on_hand: newQty, updated_at: new Date().toISOString() }).eq("id", row.id);
    }
    depleted.push({ batchId: row.batch_id, depletedQty: take });
    qtyLeft -= take;
  }
  return depleted;
}
```

- [ ] **Step 2: Verify**

```bash
npm run lint
```
Expected: clean for this file (callers still broken until Task 7 — that's fine, this task is just the leaf module).

- [ ] **Step 3: Commit**

```bash
git add lib/production/coldStorageDepletion.ts
git commit -m "refactor: rekey coldStorageDepletion to variation_id"
```

---

### Task 4: Rewrite `transfers/route.ts`

**Files:**
- Modify: `app/api/production/transfers/route.ts`

**Interfaces:**
- Consumes: `packaging_variations.total_volume_fl_oz` (Task 1), `batch_transfers.variation_id`/`quantity` (Task 2), `record_batch_transfer(p_variation_id, p_quantity, ...)` RPC (Task 2), `recipe_packaging_variations` table (Spec 9, unchanged).
- Produces: POST body shape `{ batch_id, from_tank_id, to_tank_id, transfer_type, notes, shrinkage_bbl, volume_bbl?, packaging_lines?: { variation_id: string; quantity: number }[] }` — consumed by Task 5 (TransferModal).

- [ ] **Step 1: Replace `TransferLineInput` and `processTransferLine`**

Replace lines 11-130 of `app/api/production/transfers/route.ts`:

```typescript
interface TransferLineInput {
  batch_id: string;
  from_tank_id: string | null;
  to_tank_id: string | null;
  volume_bbl: number;
  shrinkage_bbl: number;
  transfer_type: string;
  notes: string | null;
  variation_id: string | null;
  quantity: number | null;
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
  const { batch_id, from_tank_id, to_tank_id, volume_bbl, shrinkage_bbl, transfer_type, notes, variation_id, quantity, created_by, recipe_id } = line;

  const { data: transfer, error } = await supabase
    .rpc("record_batch_transfer", {
      p_batch_id:      batch_id,
      p_from_tank_id:  from_tank_id || null,
      p_to_tank_id:    to_tank_id   || null,
      p_volume_bbl:    volume_bbl,
      p_shrinkage_bbl: shrinkage_bbl ?? 0,
      p_transfer_type: transfer_type ?? "transfer",
      p_notes:         notes || null,
      p_variation_id:  variation_id ?? null,
      p_quantity:       quantity ?? null,
      p_created_by:    created_by ?? null,
    })
    .single();

  if (error) {
    const status = error.message.includes("already occupied") ? 409 : 500;
    throw Object.assign(new Error(error.message), { status });
  }

  const transferRow = transfer as { id: string };

  // ── Packaging deduction + cold storage inventory ─────────────────────────
  if (variation_id && quantity) {
    try {
      const { data: variation } = await supabase
        .from("packaging_variations")
        .select("id, container_id, lid_id, paktech_id, tray_id, label_id, total_volume_fl_oz, container:packaging_items!packaging_variations_container_id_fkey(volume_fl_oz)")
        .eq("id", variation_id)
        .single();

      if (variation) {
        const containerVolume = (variation.container as unknown as { volume_fl_oz: number | null })?.volume_fl_oz ?? 0;
        const unitsPerPackage = containerVolume > 0 ? variation.total_volume_fl_oz / containerVolume : 1;
        const totalUnits = quantity * unitsPerPackage;

        const deductions: { id: string | null; qty: number; label: string }[] = [
          { id: variation.container_id, qty: totalUnits, label: "container" },
          { id: variation.lid_id,       qty: totalUnits, label: "lids" },
          { id: variation.label_id,     qty: totalUnits, label: "labels" },
          { id: variation.tray_id,      qty: quantity,    label: "trays" },
          { id: variation.paktech_id,   qty: quantity,    label: "paktechs" },
        ];

        for (const d of deductions) {
          if (!d.id || !d.qty) continue;
          const { data: pkg } = await supabase.from("packaging_items").select("stock_quantity").eq("id", d.id).single();
          if (pkg) {
            const newQty = Number(pkg.stock_quantity) - d.qty;
            await supabase.from("packaging_items").update({ stock_quantity: newQty }).eq("id", d.id);
            await supabase.from("packaging_stock_adjustments").insert({
              packaging_item_id: d.id, quantity: -d.qty, type: "used",
              note: `${transfer_type === "kegging" ? "Kegging" : "Canning"} (${d.label}) — batch ${batch_id}`,
              batch_transfer_id: transferRow.id, cost_per_unit: null, total_value_change: null,
            });
          }
        }

        await upsertColdStorageInventory(supabase, {
          batch_id, recipe_id, variation_id, quantity_delta: quantity, source_transfer_id: transferRow.id,
        });
      }
    } catch (deductionErr) {
      console.error("[transfers] Packaging deduction / cold storage update failed (transfer committed):", deductionErr);
    }
  }

  // ── Schedule reconciliation ───────────────────────────────────────────────
  const scheduleUpdate = await reconcileSchedule(supabase, { batch_id, from_tank_id, to_tank_id, volume_bbl });

  return { transfer: transfer as Record<string, unknown>, scheduleUpdate };
}
```

- [ ] **Step 2: Leave `reconcileSchedule` untouched**

It does not reference `kegging_detail`/`canning_detail`/`variant_label` anywhere (confirmed during research) — no changes needed in that function.

- [ ] **Step 3: Replace `upsertColdStorageInventory`**

Replace lines 558-586 (the old function):

```typescript
async function upsertColdStorageInventory(
  supabase: SupabaseClient,
  args: { batch_id: string; recipe_id: string | null; variation_id: string; quantity_delta: number; source_transfer_id: string }
) {
  const { batch_id, recipe_id, variation_id, quantity_delta, source_transfer_id } = args;
  const { data: existing } = await supabase
    .from("cold_storage_inventory")
    .select("id, quantity_on_hand")
    .eq("batch_id", batch_id)
    .eq("variation_id", variation_id)
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
      batch_id, recipe_id, variation_id,
      quantity_on_hand: quantity_delta, source_transfer_id,
    });
  }
}
```

- [ ] **Step 4: Replace the `GET` handler's select to join variation name**

In the `GET` function, change the select (current line 596) to:

```typescript
    .select("*, from_tank:from_tank_id(id, name, type), to_tank:to_tank_id(id, name, type), to_batch:to_batch_id(id, beer_name, batch_number), packaging_variations(id, name), created_by")
```

- [ ] **Step 5: Replace the `POST` handler**

Replace lines 623-747 (everything from `export async function POST` to end of file):

```typescript
export async function POST(req: NextRequest) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { data: { user: currentUser } } = await supabase.auth.getUser();

  const body = await req.json();
  const {
    batch_id,
    from_tank_id,
    to_tank_id,
    transfer_type,
    notes,
    packaging_lines,
  } = body as {
    batch_id: string;
    from_tank_id: string | null;
    to_tank_id: string | null;
    transfer_type: "transfer" | "kegging" | "canning" | "conversion";
    notes: string | null;
    volume_bbl?: number;
    shrinkage_bbl?: number;
    packaging_lines?: { variation_id: string; quantity: number }[];
  };

  const { data: batchRow } = await supabase.from("brew_batches").select("recipe_id").eq("id", batch_id).single();
  const recipe_id: string | null = batchRow?.recipe_id ?? null;

  // ── Build one line per packaging variation (or a single line for plain transfers/conversions) ──
  type Line = { volume_bbl: number; shrinkage_bbl: number; variation_id: string | null; quantity: number | null };
  const lines: Line[] = [];
  const totalShrinkage = Number(body.shrinkage_bbl ?? 0);

  if ((transfer_type === "kegging" || transfer_type === "canning") && packaging_lines?.length) {
    // ── Strict-consumption gate: every submitted variation must be declared for this recipe ──
    if (!recipe_id) {
      return NextResponse.json({ error: "Batch has no recipe — packaging variations cannot be resolved." }, { status: 422 });
    }
    const { data: declaredRows } = await supabase
      .from("recipe_packaging_variations")
      .select("variation_id")
      .eq("recipe_id", recipe_id);
    const declaredIds = new Set((declaredRows ?? []).map((r) => r.variation_id));
    if (declaredIds.size === 0) {
      return NextResponse.json(
        { error: "This recipe has no packaging variations declared — add one in Recipes → Packaging Variations before kegging/canning." },
        { status: 422 }
      );
    }
    const variationIds = packaging_lines.map((l) => l.variation_id);
    const undeclared = variationIds.filter((id) => !declaredIds.has(id));
    if (undeclared.length > 0) {
      return NextResponse.json(
        { error: `Variation ${undeclared[0]} is not declared for this recipe.` },
        { status: 422 }
      );
    }

    const { data: variationRows } = await supabase
      .from("packaging_variations")
      .select("id, total_volume_fl_oz")
      .in("id", variationIds);
    const volumeById = new Map((variationRows ?? []).map((v) => [v.id, v.total_volume_fl_oz as number]));

    const totalVolume = packaging_lines.reduce((sum, l) => {
      const totalFlOz = volumeById.get(l.variation_id) ?? 0;
      return sum + (l.quantity * totalFlOz) / BBL_TO_FL_OZ;
    }, 0);

    let allocatedShrinkage = 0;
    packaging_lines.forEach((l, idx) => {
      const totalFlOz = volumeById.get(l.variation_id) ?? 0;
      const lineVolume = (l.quantity * totalFlOz) / BBL_TO_FL_OZ;
      const isLast = idx === packaging_lines.length - 1;
      const shrinkShare = isLast
        ? totalShrinkage - allocatedShrinkage
        : Math.round((totalVolume > 0 ? (lineVolume / totalVolume) * totalShrinkage : 0) * 1000) / 1000;
      allocatedShrinkage += shrinkShare;
      lines.push({ volume_bbl: lineVolume, shrinkage_bbl: shrinkShare, variation_id: l.variation_id, quantity: l.quantity });
    });
  } else {
    lines.push({ volume_bbl: Number(body.volume_bbl ?? 0), shrinkage_bbl: totalShrinkage, variation_id: null, quantity: null });
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
        variation_id: line.variation_id, quantity: line.quantity,
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

- [ ] **Step 6: Verify**

```bash
npm run lint
npm run build
```
Expected: clean for this file (TransferModal.tsx will still fail until Task 5).

- [ ] **Step 7: Commit**

```bash
git add app/api/production/transfers/route.ts
git commit -m "feat: strict variation-based packaging lines in transfers API"
```

---

### Task 5: Rewrite `TransferModal.tsx`

**Files:**
- Modify: `app/production/components/TransferModal.tsx`
- Modify: `app/production/components/BrewStatusTab.tsx` (add `recipePackagingVariations` prop at the `<TransferModal>` call site, ~line 1357-1381, and source it from `useRecipePackagingVariationsQuery()`)

**Interfaces:**
- Consumes: POST body shape from Task 4 (`packaging_lines`), `RecipePackagingVariation[]` type (existing, from Spec 9: `{ id, recipe_id, variation_id, packaging_variations: PackagingVariation }`), `useRecipePackagingVariationsQuery()` hook (existing).

- [ ] **Step 1: Update `TransferModalProps` and remove component-assembly state**

In `app/production/components/TransferModal.tsx`, change the import line (line 4) to also pull `RecipePackagingVariation`:

```typescript
import { Equipment, BrewBatch, PackagingItem, Recipe, RecipePackagingVariation, UNCONSTRAINED_EQUIPMENT_TYPES } from "../types";
```

Add `recipePackagingVariations: RecipePackagingVariation[];` to `TransferModalProps` (after `packaging: PackagingItem[];`, line 49) and to the destructured props (line 70).

Replace lines 100-136 (keg lines + 5 component dropdowns + cases/packs/looseCans state) with:

```typescript
  interface PackagingLine { variation_id: string; quantity: string }

  const recipeVariations = recipePackagingVariations
    .filter((rv) => rv.recipe_id === batch.recipe_id)
    .map((rv) => rv.packaging_variations)
    .filter((v) => v.is_active);

  const kegVariations = recipeVariations.filter((v) => v.container?.type === "keg");
  const canVariations = recipeVariations.filter((v) => v.container?.type === "can");

  const [packagingLines, setPackagingLines] = useState<PackagingLine[]>([{ variation_id: "", quantity: "" }]);
```

- [ ] **Step 2: Update `showKegDetail`/`showCanDetail` draw-volume calc**

Replace the `drawBbl` computation block (lines 171-189) — replace the `showKegDetail`/`showCanDetail` branches with a single unified one:

```typescript
  } else if (isPackagingForm) {
    drawBbl = packagingLines.reduce((sum, l) => {
      const variation = recipeVariations.find((v) => v.id === l.variation_id);
      const qty = parseInt(l.quantity) || 0;
      if (!variation) return sum;
      return sum + (qty * variation.total_volume_fl_oz) / BBL_TO_FL_OZ;
    }, 0);
  } else if (volumeMode === "full") {
```

(Keep the `mode === "convert"` branch above it unchanged; this replaces the old `showKegDetail`/`showCanDetail` `else if` pair with one combined branch since `isPackagingForm` already covers both.)

- [ ] **Step 3: Remove dead variables and the label-requirement check**

Delete the now-unused `defaultKegIds`, `defaultCan`/`defaultLid`/`defaultPaktech`/`defaultTray`/`defaultLabel`, `kegs`/`cans`/`lids`/`paktechs`/`trays`/`labels`, `selectedTray`/`cansPerCase`/`selectedPaktech`/`cansPerPack`/`selectedCan`/`canRequiresLabel` (lines 107-111, 154-166) — none of these are needed once selection is variation-based; label/lid/paktech/tray are now implied by the chosen variation, not separately picked. Delete the `showCanDetail && canRequiresLabel && !labelId` guard in `handleSubmit` (lines 256-259) for the same reason — a declared variation, by construction (Spec 9's `validateFormat`), already has whatever label it needs.

- [ ] **Step 4: Replace `handleSubmit`'s line-building logic**

Replace lines 261-284:

```typescript
      let packaging_lines: { variation_id: string; quantity: number }[] | undefined;
      let transfer_type: "transfer" | "kegging" | "canning" = "transfer";

      if (showKegDetail) {
        transfer_type = "kegging";
        packaging_lines = packagingLines
          .filter((l) => l.variation_id && (parseInt(l.quantity) || 0) > 0)
          .map((l) => ({ variation_id: l.variation_id, quantity: parseInt(l.quantity) || 0 }));
      } else if (showCanDetail) {
        transfer_type = "canning";
        packaging_lines = packagingLines
          .filter((l) => l.variation_id && (parseInt(l.quantity) || 0) > 0)
          .map((l) => ({ variation_id: l.variation_id, quantity: parseInt(l.quantity) || 0 }));
      }
```

And replace the `fetch` body (lines 286-300):

```typescript
      const res = await fetch("/api/production/transfers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batch_id:      batch.id,
          from_tank_id:  fromTank.id,
          to_tank_id:    effectiveDestId,
          ...(packaging_lines ? {} : { volume_bbl: drawBbl }),
          shrinkage_bbl: shrinkBbl,
          transfer_type,
          notes:         notes || null,
          packaging_lines,
        }),
      });
```

- [ ] **Step 5: Replace the Keg detail and Can detail JSX blocks**

Replace both the "Keg detail" block (lines 488-526) and "Can detail" block (lines 528-580) with one unified block, placed where the keg-detail block was:

```typescript
        {/* ── Packaging detail (kegging or canning) ── */}
        {isPackagingForm && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs text-zinc-400">{showKegDetail ? "Kegs" : "Cans"}</label>
              <button type="button" onClick={() => setPackagingLines((l) => [...l, { variation_id: "", quantity: "" }])}
                className="text-xs text-amber-500 hover:text-amber-400">+ Add line</button>
            </div>
            {(showKegDetail ? kegVariations : canVariations).length === 0 && (
              <p className="text-xs text-zinc-600">
                No packaging variations declared for this recipe — add one in Recipes → Packaging Variations.
              </p>
            )}
            <div className="space-y-2">
              {packagingLines.map((line, i) => (
                <div key={i} className="grid items-center gap-2" style={{ gridTemplateColumns: "1fr 64px auto" }}>
                  <select className="inp" value={line.variation_id}
                    onChange={(e) => setPackagingLines((ls) => ls.map((l, idx) => idx === i ? { ...l, variation_id: e.target.value } : l))}>
                    <option value="">— select variation —</option>
                    {(showKegDetail ? kegVariations : canVariations).map((v) => (
                      <option key={v.id} value={v.id}>{v.name}</option>
                    ))}
                  </select>
                  <input type="number" min="0" className="inp" placeholder="qty"
                    value={line.quantity}
                    onChange={(e) => setPackagingLines((ls) => ls.map((l, idx) => idx === i ? { ...l, quantity: e.target.value } : l))} />
                  {packagingLines.length > 1
                    ? <button type="button" onClick={() => setPackagingLines((ls) => ls.filter((_, idx) => idx !== i))}
                        className="text-zinc-600 hover:text-red-400 text-lg leading-none">×</button>
                    : <span />}
                </div>
              ))}
            </div>
            <p className="text-xs text-zinc-500 mt-2">
              Total: {packagingLines.reduce((s, l) => s + (parseInt(l.quantity) || 0), 0)} · Draw: {fmtBbl(drawBbl)}
            </p>
          </div>
        )}
```

Also disable the submit button when the relevant variation list is empty — in `ModalActions`, the existing `submitting` prop already disables it during submission; add a `disabled` check inline before `ModalActions` is rendered is unnecessary since an empty `<select>` with no valid option simply can't produce a `variation_id`, and `packaging_lines` filters those out — submitting with zero lines naturally yields an empty `packaging_lines` array, which the API treats as "no packaging_lines" and falls through to the plain-transfer branch (Task 4, `else` clause) using `body.volume_bbl` (which will be `drawBbl = 0` here). To avoid that silent no-op, add an explicit guard at the top of `handleSubmit`, right after the capacity-guard block:

```typescript
      if (isPackagingForm && !(packagingLines.some((l) => l.variation_id && (parseInt(l.quantity) || 0) > 0))) {
        alert("Select at least one packaging variation and quantity.");
        return;
      }
```

- [ ] **Step 6: Update `BrewStatusTab.tsx` call site**

In `app/production/components/BrewStatusTab.tsx`, add the import and hook call near the existing `usePackagingQuery()` (line 156):

```typescript
const { data: recipePackagingVariations = [] } = useRecipePackagingVariationsQuery();
```

(Add `useRecipePackagingVariationsQuery` to the existing import from `../hooks/queries`.)

Add `recipePackagingVariations={recipePackagingVariations}` to the `<TransferModal>` JSX (alongside `packaging={packaging}`, ~line 1363).

- [ ] **Step 7: Verify**

```bash
npm run lint
npm run build
```
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add app/production/components/TransferModal.tsx app/production/components/BrewStatusTab.tsx
git commit -m "feat: strict variation picker replaces ad-hoc packaging assembly in TransferModal"
```

---

### Task 6: Fix `coldStorage.ts` and `demand-calendar/route.ts`

**Files:**
- Modify: `app/production/lib/coldStorage.ts`
- Modify: `app/api/production/demand-calendar/route.ts`

**Interfaces:**
- Consumes: `BatchTransfer.variation_id`/`quantity` (Task 2), `PackagingVariation.total_volume_fl_oz` + `.container.type` (Task 1, Spec 9).
- Produces: `ColdStorageLot.packaging: "keg" | "can"`, `ColdStorageLot.initialQty: number` (unchanged shape, consumed by `demandCalendar.ts` — not modified by this plan since it only consumes the existing `ColdStorageLot` interface, which is unchanged).

- [ ] **Step 1: Rewrite `transferInitialQty` and `coldStorageLots`**

Replace the full content of `app/production/lib/coldStorage.ts`:

```typescript
import { BatchTransfer, Equipment, BrewBatch, PackagingVariation } from "../types";

/** Initial packaged quantity recorded on a kegging/canning transfer. */
export function transferInitialQty(t: BatchTransfer): { qty: number; unit: "keg" | "can" } {
  const unit = t.transfer_type === "kegging" ? "keg" : "can";
  return { qty: t.quantity ?? 0, unit };
}

export interface ColdStorageLot {
  transfer: BatchTransfer;
  batch: BrewBatch | undefined;
  packaging: "keg" | "can";
  initialQty: number;
}

/**
 * Packaged lots currently held in cold storage: kegging/canning transfers whose
 * destination tank is a cold_storage unit. NOTE initialQty is the recorded packaged
 * count; net on-hand additionally requires summing brew_inventory_adjustments per lot.
 */
export function coldStorageLots(
  transfers: BatchTransfer[],
  tanks: Equipment[],
  batches: BrewBatch[],
): ColdStorageLot[] {
  const coldStorageTankIds = new Set(tanks.filter((t) => t.type === "cold_storage").map((t) => t.id));
  const batchById = new Map(batches.map((b) => [b.id, b]));
  return transfers
    .filter(
      (t) =>
        t.to_tank_id &&
        coldStorageTankIds.has(t.to_tank_id) &&
        (t.transfer_type === "kegging" || t.transfer_type === "canning"),
    )
    .map((t) => {
      const { qty, unit } = transferInitialQty(t);
      return { transfer: t, batch: batchById.get(t.batch_id), packaging: unit, initialQty: qty };
    });
}
```

(`unit` is now derived from `transfer_type`, which is already always set correctly by `TransferModal`/the transfers route — same source of truth `transferInitialQty` already trusted before, just no longer cross-checked against a JSONB detail object that no longer exists.)

- [ ] **Step 2: Fix the demand-calendar proxy-lookup bug**

In `app/api/production/demand-calendar/route.ts`, replace the comment block and `packagingByBatchTransfer` construction (current lines 73-84):

```typescript
    // Resolve each lot's real packaging item via the variation actually
    // recorded on its transfer — no more guessing a "default" item per type.
    const variationIds = [...new Set(typedTransfers.map((t) => t.variation_id).filter((id): id is string => !!id))];
    const { data: variationRows } = await supabase
      .from("packaging_variations")
      .select("id, container_id, container:packaging_items!packaging_variations_container_id_fkey(*)")
      .in("id", variationIds.length > 0 ? variationIds : ["00000000-0000-0000-0000-000000000000"]);
    const containerByVariationId = new Map(
      (variationRows ?? []).map((v) => [v.id, v.container as unknown as PackagingItem])
    );

    const packagingByBatchTransfer = new Map<string, PackagingItem>();
    const lots = coldStorageLots(typedTransfers, typedTanks, typedBatches);
    for (const lot of lots) {
      const container = lot.transfer.variation_id ? containerByVariationId.get(lot.transfer.variation_id) : undefined;
      if (container) packagingByBatchTransfer.set(lot.transfer.id, container);
    }
```

This requires `supabase` to already be in scope (it is — `const supabase = await createSupabaseServerClient();` is declared at the top of the `GET` handler) and `PackagingItem` to already be imported (it is, line ~9-10's type import list).

- [ ] **Step 3: Verify**

```bash
npm run lint
npm run build
```
Expected: clean.

- [ ] **Step 4: Verify the fix against live data**

```bash
curl -s "http://localhost:3000/api/production/demand-calendar" | head -c 2000
```
(With `npm run dev` running.) Confirm no errors and that rows for recipes with non-default keg/can sizes show the correct container, not always the `is_default` one. If no live kegging/canning transfers exist yet to exercise this, note that explicitly rather than claiming full verification (Lesson #9 — a feature with no real data to exercise it can't be claimed fully verified).

- [ ] **Step 5: Commit**

```bash
git add app/production/lib/coldStorage.ts app/api/production/demand-calendar/route.ts
git commit -m "fix: resolve real packaging container via variation_id in demand-calendar"
```

---

### Task 7: Rekey ExportBayTab + export-bay routes

**Files:**
- Modify: `app/production/components/ExportBayTab.tsx`
- Modify: `app/api/production/export-bay/inventory/route.ts`
- Modify: `app/api/production/export-bay/ship/route.ts`
- Modify: `app/api/production/export-bay/ship-adhoc/route.ts`

**Interfaces:**
- Consumes: `cold_storage_inventory.variation_id` (Task 2), `getAvailableColdStorageQuantity`/`depleteColdStorageInventory` with `{ recipeId, variationId }` (Task 3), `AvailableInventoryLine` type (Task 2).
- Note: `export_transactions.packaging_item_id`/`variant_label` columns are **unchanged** (Spec 11 already confirmed this is correct as-is) — these routes resolve `variation_id` → `{ packaging_item_id: variation.container_id, variant_label: variation.name }` before calling `writeExportTransaction`, which keeps its existing signature untouched.

- [ ] **Step 1: Rewrite `export-bay/inventory/route.ts`**

```typescript
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// GET /api/production/export-bay/inventory
// Returns available cold-storage inventory grouped by recipe + packaging
// variation, summed across every batch — the Export Bay's "Available" column.
// No batch breakdown is exposed; from a shipping standpoint the user only
// cares about total units on hand per recipe+variation.
export async function GET() {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("cold_storage_inventory")
    .select("recipe_id, variation_id, quantity_on_hand, packaging_variations(name)")
    .not("recipe_id", "is", null);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const grouped = new Map<string, { recipe_id: string; variation_id: string; variation_name: string; quantity_on_hand: number }>();
  for (const row of data ?? []) {
    const key = `${row.recipe_id}|${row.variation_id}`;
    const variationName = (row.packaging_variations as unknown as { name: string } | null)?.name ?? "Unknown variation";
    const existing = grouped.get(key);
    if (existing) {
      existing.quantity_on_hand += Number(row.quantity_on_hand);
    } else {
      grouped.set(key, {
        recipe_id: row.recipe_id as string,
        variation_id: row.variation_id,
        variation_name: variationName,
        quantity_on_hand: Number(row.quantity_on_hand),
      });
    }
  }

  const lines = [...grouped.values()].filter((l) => l.quantity_on_hand > 0.001);
  return NextResponse.json(lines);
}
```

- [ ] **Step 2: Rewrite `export-bay/ship/route.ts`**

Replace the `ShipRequest` interface and the body destructure (lines 13-19) with:

```typescript
interface ShipRequest {
  partner_id: string;
  recipe_id: string;
  variation_id: string;
  quantity: number;
  notes?: string | null;
}
```

```typescript
  const { partner_id, recipe_id, variation_id, quantity, notes } = body;

  if (!partner_id || !recipe_id || !variation_id || !quantity || quantity <= 0) {
    return NextResponse.json({ error: "partner_id, recipe_id, variation_id, and a positive quantity are required" }, { status: 400 });
  }
```

Replace the "1. Volume conversion" block (current lines that select `packaging_items.volume_fl_oz` by `packaging_item_id`) with a variation lookup that also yields `container_id`/`name` for later use:

```typescript
  // ── 1. Resolve variation → volume + display name + container item id ─────
  const { data: variation, error: varErr } = await supabase
    .from("packaging_variations")
    .select("total_volume_fl_oz, container_id, name")
    .eq("id", variation_id)
    .single();
  if (varErr) return NextResponse.json({ error: varErr.message }, { status: 500 });
  if (!variation) return NextResponse.json({ error: "Variation not found." }, { status: 404 });
  const requestedBbl = (quantity * variation.total_volume_fl_oz) / BBL_TO_FL_OZ;
```

(Drop the old `volumeFlOz`/`requestedBbl` computation that used `packaging_items` directly — `requestedBbl` is now computed inline above.)

Replace the "2. Validate availability" block's call:

```typescript
    totalAvailable = await getAvailableColdStorageQuantity(supabase, {
      recipeId: recipe_id,
      variationId: variation_id,
    });
```//
and its error message: `Insufficient cold storage inventory for "${variation.name}" — requested ${quantity}, available ${totalAvailable}`.

Replace the "5. Deplete" call:

```typescript
    await depleteColdStorageInventory(supabase, {
      recipeId: recipe_id,
      variationId: variation_id,
      quantity,
    });
```

Replace the `writeExportTransaction` call inside the per-batch loop (Section "6/7"), passing through the resolved container id and name instead of the old `packaging_item_id`/`variant_label` request fields:

```typescript
        exportTxId = await writeExportTransaction(supabase, {
          shipmentId,
          batchId,
          recipeId: recipe_id,
          packagingItemId: variation.container_id,
          variantLabel: variation.name,
          quantity: c.creditedQty,
          volumeBbl: c.creditedBbl,
          channel: c.channel,
          recipientId: partner_id,
          recipientName: null,
          allocationId: c.allocationId,
          sourceTransferId: transferId,
          notes,
        });
```

- [ ] **Step 3: Rewrite `export-bay/ship-adhoc/route.ts`**

Apply the same pattern: `AdHocShipRequest` drops `packaging_item_id`/`variant_label`, adds `variation_id: string`; the volume-conversion block becomes the same variation lookup as Step 2; `getAvailableColdStorageQuantity`/`depleteColdStorageInventory` calls use `{ recipeId, variationId }`; the `writeExportTransaction` call passes `packagingItemId: variation.container_id, variantLabel: variation.name`. The depleted-row loop (`for (const { batchId, depletedQty } of depleted)`) computes `volumeBbl` as `(depletedQty * variation.total_volume_fl_oz) / BBL_TO_FL_OZ` instead of the old `volumeFlOz`-based formula.

- [ ] **Step 4: Update `ExportBayTab.tsx`**

Replace `ShipModal`'s state and line-selection logic (current lines 201-212):

```typescript
  const [variationId, setVariationId] = useState(inventoryLines[0]?.variation_id ?? "");
  const [quantity, setQuantity] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
```

(Remove `handleSelectLine` — the `<select>` can bind directly to `variationId` now since it's a single key, not a composite string.)

Replace the fetch body (lines 222-227):

```typescript
        body: JSON.stringify({
          partner_id: group.partnerId,
          recipe_id: group.recipeId,
          variation_id: variationId,
          quantity: parseFloat(quantity),
          notes: notes || null,
        }),
```

Replace the `<select>` JSX (lines 242-250):

```typescript
            <select className="inp w-full" value={variationId} onChange={(e) => setVariationId(e.target.value)}>
              {inventoryLines.map((l) => (
                <option key={l.variation_id} value={l.variation_id}>
                  {l.variation_name} ({l.quantity_on_hand} available)
                </option>
              ))}
            </select>
```

And the inventory display list (current lines 104-109, in the parent `ExportBayTab` component):

```typescript
                  {lines.map((l) => (
                    <div key={l.variation_id} className="flex items-center justify-between px-3 py-2 text-sm">
                      <span className="text-zinc-300">{l.variation_name}</span>
                      <span className="text-zinc-400 tabular-nums">{l.quantity_on_hand}</span>
                    </div>
                  ))}
```

Apply the identical pattern to `AdHocExportModal` (lines 275-352): replace `packagingItemId`/`variantLabel` state with `variationId`, remove `handleSelectLine`, update the fetch body to send `variation_id: variationId` instead of `packaging_item_id`/`variant_label`, and update its `<select>` JSX the same way as `ShipModal`'s.

- [ ] **Step 5: Verify**

```bash
npm run lint
npm run build
```
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add app/production/components/ExportBayTab.tsx app/api/production/export-bay/inventory/route.ts app/api/production/export-bay/ship/route.ts app/api/production/export-bay/ship-adhoc/route.ts
git commit -m "feat: rekey ExportBayTab and ship routes to variation_id"
```

---

### Task 8: Final sweep + whole-branch verification

**Files:** none specific — this task searches for stragglers and runs final checks.

- [ ] **Step 1: Grep for any remaining references to removed fields**

```bash
grep -rn "variant_label\|packaging_item_id\|kegging_detail\|canning_detail" app/ lib/ --include="*.ts" --include="*.tsx" | grep -v "export_transactions\|exportTransactionWriter\|export-bay/ship"
```

Expected: no hits outside of `export_transactions`-related code (which intentionally keeps `packaging_item_id`/`variant_label` per Spec 11's confirmed-correct design) and the two export-bay ship routes (which legitimately still pass `packagingItemId`/`variantLabel` into `writeExportTransaction`, just resolved from `variation_id` now per Task 7). If anything else turns up (e.g. a report component, a CSV export, a stray reference in `app/production/lib/demandCalendar.ts`), read that file and fix it before proceeding — this is exactly the kind of straggler the spec's "no backfill but full forward wiring" principle is meant to catch.

- [ ] **Step 2: Full lint + build**

```bash
npm run lint
npm run build
```
Expected: 0 errors, 0 warnings.

- [ ] **Step 3: Manual smoke check against live data**

With `npm run dev` running and a recipe that has at least one `recipe_packaging_variations` row declared (seed one via the Recipes UI if none exist), open Production → Brewing → a fermenter/brite tank with that batch → Transfer → destination = a kegging or canning tank, and confirm the new variation picker renders the declared variation(s) and submits successfully, creating a `cold_storage_inventory` row keyed by `variation_id`. State explicitly in the final report whether this live click-through was actually performed or whether no suitable batch/recipe existed to test against (Lesson #7/#9 — don't imply E2E coverage that didn't happen).

- [ ] **Step 4: Commit (if Step 1 found anything to fix)**

```bash
git add -A
git commit -m "fix: remaining stragglers from variant_label/packaging_item_id rekey"
```

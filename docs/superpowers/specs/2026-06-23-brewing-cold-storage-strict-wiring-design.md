# Spec 10: Brewing/Kegging-Canning + Cold Storage Strict Wiring — Design

## Context

Spec 9 (merged, PR #25) built `packaging_variations` (container + format + 4 nullable component-FK slots + optional partner exclusivity) and `recipe_packaging_variations` (declares which variations are valid for a given recipe), but wired up nothing downstream — `TransferModal.tsx`, `transfers/route.ts`, `cold_storage_inventory`, `demand-calendar/route.ts`, and `ExportBayTab.tsx` all still run on the old model: ad-hoc component assembly (5 separate dropdowns: can/lid/paktech/tray/label) at transfer time, plus a free-text `variant_label` string, with zero structured link to any `packaging_variations` row.

**Strict-consumption principle (user-confirmed, applies to this spec):** once a recipe has variations declared via `recipe_packaging_variations`, those are the *only* valid choices for that recipe downstream — no ad-hoc component assembly, no free-text `variant_label`. This is a UI behavior change (pick-from-declared-list), not just a backend rekey.

**Legacy data:** existing `cold_storage_inventory` rows (free-text `variant_label`) and `batch_transfers.kegging_detail`/`canning_detail` JSONB rows are confirmed-disposable test data. No backfill/reconciliation — this spec resets live inventory and drops the legacy JSONB columns outright.

## Schema changes

### `batch_transfers` — extend, don't fork a new table

Add two nullable columns:
- `variation_id uuid references packaging_variations(id) on delete restrict` — null for plain `transfer`/`conversion` rows; set for `kegging`/`canning` rows.
- `quantity numeric` — count of packages this row represents (number of kegs, or number of cases/packs/loose cans).

Drop `kegging_detail` and `canning_detail` JSONB columns entirely.

A single kegging/canning action that produces multiple variations (e.g. some 1/2 kegs + some 1/6 kegs in one draw) now creates **multiple `batch_transfers` rows** — one per variation — sharing `from_tank_id`/`to_tank_id`/`transferred_at`/`notes`/`transfer_type`, each with its own `volume_bbl`/`shrinkage_bbl` share and `variation_id`/`quantity`.

This was verified safe against existing consumers: `volumeLedger.ts` (`computeTankVolumes`, `computeLocationBreakdown`) and `commitments.ts` treat `batch_transfers` as a purely additive ledger — every aggregate is a `reduce`/sum over all rows for a batch/tank, with no per-row-as-discrete-action logic. The transfer-log UI (`transfers/page.tsx`, `BatchLogTab.tsx`) lists rows independently with no grouping, so multiple rows from one action render as multiple line items, not as a UI break.

### `packaging_variations` — add a computed total volume

Add `total_volume_fl_oz numeric not null`, computed server-side (never client-submitted):
```
total_volume_fl_oz = container.volume_fl_oz × unitsPerPackage
unitsPerPackage =
  format === "case"              ? tray.can_count
  format in ("4-pack","6-pack")  ? paktech.can_count
  /* "loose", also the only valid format for keg containers */ : 1
```
Computed once at variation create/update time (Spec 9's existing route), using the same `format`/`tray_id`/`paktech_id` invariants `validateFormat()` already enforces (`lib/production/packagingVariations.ts:11-24`) — so the branch above is exhaustive and never hits a null lookup.

**Cascade recompute via DB trigger** — if a `packaging_items` row's `volume_fl_oz` or `can_count` changes after variations reference it, every dependent `packaging_variations` row recomputes automatically:
```sql
create or replace function recompute_variation_total_volume() returns trigger as $$
begin
  update packaging_variations v
  set total_volume_fl_oz = c.volume_fl_oz * coalesce(
    case
      when v.format = 'case' then t.can_count
      when v.format in ('4-pack', '6-pack') then p.can_count
      else 1
    end, 1)
  from packaging_items c
  left join packaging_items t on t.id = v.tray_id
  left join packaging_items p on p.id = v.paktech_id
  where c.id = v.container_id
    and (v.container_id = new.id or v.tray_id = new.id or v.paktech_id = new.id);
  return new;
end;
$$ language plpgsql;

create trigger trg_recompute_variation_total_volume
  after update of volume_fl_oz, can_count on packaging_items
  for each row execute function recompute_variation_total_volume();
```
This guarantees correctness at the DB level regardless of write path — both the variation route's own initial compute on insert, and any later edit to the underlying catalog item.

### `cold_storage_inventory` — rekey to variation_id

Drop `packaging_item_id` and `variant_label`. Add `variation_id uuid not null references packaging_variations(id) on delete restrict`. Unique index becomes `(batch_id, variation_id)`. Table is truncated as part of this migration (confirmed OK — live inventory reset, fresh transfers go through the new model going forward).

No denormalized label columns anywhere in this spec — display name always comes from joining live to `packaging_variations.name`, so a later rename in the Recipes UI is reflected everywhere automatically.

## API: `transfers/route.ts`

Request body collapses `kegging_lines`/`canning_lines` into one unified shape:
```ts
{
  batch_id, from_tank_id, to_tank_id, transfer_type, notes, shrinkage_bbl,
  packaging_lines: { variation_id: string; quantity: number }[]
}
```

Server-side, for every `variation_id` submitted:
1. Resolve the batch's `recipe_id`. Reject with 422 (`"Variation <name> is not declared for this recipe"`) if `variation_id` is not present in `recipe_packaging_variations` for that recipe — this route is the actual strict-consumption enforcement gate, not just the UI.
2. If the recipe has zero declared variations at all, reject upfront with a clear error pointing at Recipes → Packaging Variations, before any row is written.
3. Compute `volume_bbl = (quantity * variation.total_volume_fl_oz) / BBL_TO_FL_OZ` — sourced entirely from the variation's own fixed, server-computed total, never from client-submitted component ids.
4. Allocate `shrinkage_bbl` proportionally to each line's share of total volume produced across all lines in the request (unifying kegging's existing volume-based allocation and canning's existing unit-count-based allocation into one volume-based rule) — the **last line absorbs the rounding remainder** (`totalShrinkage - allocatedShrinkage`) so the sum across all lines exactly equals the entered total shrinkage, matching today's no-drift guarantee.

Each line becomes its own `batch_transfers` row (`variation_id`, `quantity`, computed `volume_bbl`/`shrinkage_bbl`) and its own `cold_storage_inventory` upsert keyed on `(batch_id, variation_id)`.

## UI: `TransferModal.tsx`

Replaces the 5-field component-assembly form (can/lid/paktech/tray/label dropdowns) and the keg multi-line picker with one unified pattern for both kegging and canning:

- On opening the modal for a kegging/canning destination, fetch `recipe_packaging_variations` for the batch's recipe, filtered to variations whose `container_id` resolves to the matching equipment type (keg-type containers for kegging equipment, can-type containers for canning equipment).
- Render as a multi-line picker (mirrors today's keg-line UX): each line is a `<select>` of that recipe's declared variations (showing `packaging_variations.name`) + a quantity field, with "+ Add line" to add more variations to the same transfer.
- If the recipe has zero declared variations for that equipment type, show an inline empty state ("No packaging variations declared for this recipe — add one in Recipes → Packaging Variations") and disable submit.
- On submit, builds `packaging_lines: { variation_id, quantity }[]` and POSTs the unified shape above. No client-side volume/shrinkage math — that's entirely server-side now.

Removes: `canId`/`lidId`/`paktechId`/`trayId`/`labelId`/`cases`/`packs`/`looseCans` state and the associated five-dropdown JSX block.

## `demand-calendar/route.ts` fix

The proxy-lookup bug (`demand-calendar/route.ts:73-84`) currently guesses a "default packaging item for this type" per lot instead of using real per-lot data. With `variation_id` and `total_volume_fl_oz` now real columns, the fix is a direct join — no guessing, no default-item fallback:
```ts
const lots = coldStorageLots(typedTransfers, typedTanks, typedBatches);
const packagingByBatchTransfer = new Map<string, PackagingVariation>();
for (const lot of lots) {
  const variation = variationsById.get(lot.transfer.variation_id);
  if (variation) packagingByBatchTransfer.set(lot.transfer.id, variation);
}
```

`coldStorageLots()`/`transferInitialQty()` (`app/production/lib/coldStorage.ts`) are rewritten to read `transfer.quantity` and `transfer.variation_id` directly off the flat `batch_transfers` row instead of parsing the now-dropped JSONB columns. `ColdStorageLot.packaging` (`"keg" | "can"`) is derived from `variation.container.type` instead of `transfer_type` string matching.

## `ExportBayTab.tsx` + cold-storage depletion

Forced by the `cold_storage_inventory` rekey above — not optional scope, a direct consequence:

- `AvailableInventoryLine` (`types.ts:144-149`): `{ recipe_id, packaging_item_id, variant_label, quantity_on_hand }` → `{ recipe_id, variation_id, quantity_on_hand }` (display name joined live from `packaging_variations.name`).
- `ColdStorageKey` type in `lib/production/coldStorageDepletion.ts`: `{ recipeId, packagingItemId, variantLabel }` → `{ recipeId, variationId }`. `getAvailableColdStorageQuantity`/`depleteColdStorageInventory` logic (sum / oldest-first decrement) is otherwise unchanged — just a narrower key.
- `ShipModal` in `ExportBayTab.tsx` (lines 198-283): swaps `packagingItemId`/`variantLabel` state for a single `variationId`; `handleSelectLine` keys off `l.variation_id` instead of the composite `${packaging_item_id}|${variant_label}` string.
- `export-bay/ship/route.ts` request body: `packaging_item_id` + `variant_label` → `variation_id`.

## Out of scope

- Spec 8 (Intake/Commitments `commitment_packaging_preferences` strict wiring) — separate spec, reuses this spec's pattern.
- Any backfill/reconciliation of pre-existing free-text `variant_label` data — confirmed disposable.

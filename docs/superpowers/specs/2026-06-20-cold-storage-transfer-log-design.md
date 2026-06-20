# Cold Storage + Transfer Log Redesign

**Spec 1 of 4** in the Invoicing / Kegging-Canning / Cold Storage / Export feature roadmap:
1. **Cold Storage + Transfer Log schema** (this spec)
2. Export Transaction model + Export Bay UI
3. Export > Commitments unified invoicing (Packaging Fees / Bulk Discount / Excise / Keg Cleaning / Forklift)
4. Export Settings + Barrel Excise Tax settings (mirrored to Finance > Settings)

The deposit-invoice flow (Commitment → Batch → Allocation Plan → Deposit Invoice → Paid → Locked) described in steps 1-6 of the original feature request is **already implemented** (`batch_allocations`, `lib/square/deposit-invoices.ts`, `/api/production/allocations/[id]/invoice`) and is out of scope here; it gets a lighter audit pass once Spec 2-4 land, to confirm status semantics still line up end-to-end.

## Problem

Kegging/canning recording and cold storage today are implicit:
- `batch_transfers` stores one row per "Record Transfer" click, with all packaging variations (e.g. both 1/2 Kegs and 1/6 Kegs produced in one event) collapsed into a single `kegging_detail`/`canning_detail` jsonb blob.
- There is no first-class "cold storage inventory" — what's physically available is only derivable by parsing transfer jsonb across all batches, which won't scale to the Export Bay's "available inventory grouped by recipe + packaging variation, with batch attribution" requirement (Spec 2).
- There's no way to distinguish a "blank" can (requires a label) from a regular can at the data level.

## Goals

- One `batch_transfers` row per packaging variation produced in a single kegging/canning event (e.g. 2 rows if both 1/2 Kegs and 1/6 Kegs were produced), matching the original feature spec's "individual Transfer Log" requirement — without adding a parent/child table, per explicit preference for one flat table that maximizes query/join capability.
- A first-class `cold_storage_inventory` table that can answer "what's available, grouped by recipe and packaging variation, attributed to source batch" without parsing jsonb.
- Blank-can detection via a flag on `packaging_items`, enforced in the canning UI (label required).
- Zero impact on existing tank-location ledger (`volumeLedger.ts`) or `batch_exhaustion` view — both aggregate by `volume_bbl`/`transfer_type`, not by row identity, and are unaffected by splitting one event into multiple rows, **provided** each row's `volume_bbl` correctly reflects its slice of the total.

## Non-Goals

- Export Bay UI, Export Transaction model, allocation matching/adjustment, refund flow — Spec 2.
- Invoice generation rules (Packaging Fees vs. Bulk Discount, Excise Tax, Keg Cleaning, Forklift Fee) — Spec 3.
- Export Settings, Barrel Excise Tax configuration — Spec 4.
- Changing the deposit-invoice flow (steps 1-6) — already implemented, audited later.

## Data Model

### New table: `cold_storage_inventory`

```sql
create table public.cold_storage_inventory (
  id                  uuid primary key default gen_random_uuid(),
  batch_id            uuid not null references brew_batches(id) on delete cascade,
  recipe_id           uuid references recipes(id) on delete set null,
  packaging_item_id   uuid not null references packaging_items(id) on delete restrict,
  variant_label       text not null,        -- e.g. "1/2 Keg", "Case (24ct)", "4-Pack", "Loose Can"
  quantity_on_hand    numeric not null default 0,
  source_transfer_id  uuid references batch_transfers(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index cold_storage_inventory_batch_idx on cold_storage_inventory(batch_id);
create index cold_storage_inventory_packaging_idx on cold_storage_inventory(packaging_item_id);
create unique index cold_storage_inventory_batch_variant_idx
  on cold_storage_inventory(batch_id, packaging_item_id, variant_label);
```

One row per `(batch_id, packaging_item_id, variant_label)`. `recipe_id` is denormalized from the batch at write time for fast grouping in Export Bay without a join. `quantity_on_hand` is incremented on kegging/canning, decremented on export (Spec 2). `source_transfer_id` is `on delete set null` so inventory history survives if a transfer row is later removed, even after partial export.

### `packaging_items` — new column

```sql
alter table packaging_items add column if not exists requires_label boolean not null default false;
```
Set `true` on blank-can SKUs. Canning UI requires a `label_packaging_id` selection when the chosen can has `requires_label = true`.

### `batch_transfers` — no schema change, only semantics

Stays exactly as-is structurally. What changes is that one "Record Transfer" submission now produces **multiple rows** (one per packaging variation) instead of one row with an array inside the jsonb. Each row's `kegging_detail`/`canning_detail` narrows from "array of variations" to "single variation":

```ts
// kegging_detail (per row, was previously { kegs: [...] })
{ packaging_id, name, volume_fl_oz, quantity, variant_label }

// canning_detail (per row) — one of three shapes depending on format:
{ format: "case", tray_packaging_id, can_packaging_id, lid_packaging_id, label_packaging_id, cans_per_case, quantity, variant_label }
{ format: "pack", paktech_packaging_id, can_packaging_id, lid_packaging_id, label_packaging_id, cans_per_pack, quantity, variant_label }
{ format: "loose", can_packaging_id, lid_packaging_id, label_packaging_id, quantity, variant_label }
```

Rows from the same "Record Transfer" click share `batch_id` + `transferred_at` (to the same timestamp) so the UI can visually group them, without a parent-event FK.

`record_batch_transfer` RPC signature is unchanged. The route calls it once per variation line, inside one Postgres transaction, so a failure partway through rolls back every line from that submission.

### Volume & shrinkage allocation

User still enters one total `volume_bbl` (and optionally `shrinkage_bbl`) for the whole kegging/canning event. Each line's `volume_bbl` = `line_quantity × known_volume_per_unit_bbl` (derived from `packaging_items.volume_fl_oz` for kegs, or can size × count for canning formats). Shrinkage is allocated proportional to each line's volume share of the total; any rounding remainder is assigned to the largest line so the sum reconciles exactly to the user-entered total.

## API Changes

`/api/production/transfers` (POST) request shape changes from single `kegging_detail`/`canning_detail` objects to arrays:

```ts
{
  batch_id, from_tank_id, to_tank_id, volume_bbl, shrinkage_bbl, transfer_type, notes,
  kegging_lines?: { packaging_id: string; quantity: number }[],
  canning_lines?: { format: "case" | "pack" | "loose"; quantity: number; /* format-specific packaging ids */ }[],
}
```

For each non-zero line:
1. Compute that line's `volume_bbl`/`shrinkage_bbl` slice.
2. Call `record_batch_transfer` RPC (tank ledger + status auto-transition unchanged).
3. Run existing packaging-deduction logic (now scoped to that one line instead of the whole jsonb blob) → `packaging_stock_adjustments` row(s).
4. Upsert `cold_storage_inventory` (increment `quantity_on_hand` for the matching `(batch_id, packaging_item_id, variant_label)`, insert if absent).

All wrapped in a single transaction so the submission is all-or-nothing.

## UI Changes

**Kegging form (TransferModal.tsx):** no new fields — quantity-per-keg-size inputs already exist. Submit logic changes to build `kegging_lines[]` (one entry per non-zero keg-size input) instead of one `kegging_detail` object.

**Canning form (TransferModal.tsx):** add Tray and PakTech selectors that drive read-only Case/Pack counts (`case_count = floor(can_qty_for_cases / tray.can_count)`-style derivation, exact UX TBD at implementation time against existing loose-can field). If the selected can has `requires_label = true`, the Label dropdown becomes required and "Record Transfer" is disabled until set.

## Edge Cases

- Zero-quantity lines are omitted entirely — no empty `batch_transfers` row, no inventory row.
- Deleting a multi-line transfer: rows from one event share `batch_id` + `transferred_at`; UI groups them visually for "delete as a set," but each row's own `cold_storage_inventory`/`packaging_stock_adjustments` cascade independently per existing FK behavior.
- RPC failure partway through a multi-line submission rolls back the entire submission (no partial kegging/canning records).
- `batch_exhaustion` view and `volumeLedger.ts` require no changes — verified both aggregate by `volume_bbl`/`transfer_type`, not row count, so multiple rows per event sum correctly as long as volume/shrinkage allocation (above) is correct.

## Testing

- Unit test the volume/shrinkage proportional-split + rounding-remainder logic in isolation.
- Integration test: submit a kegging transfer with 2 keg sizes → assert 2 `batch_transfers` rows, 2 `packaging_stock_adjustments` rows, 2 `cold_storage_inventory` rows, and that `batch_exhaustion.kegged_bbl` equals the original total.
- Integration test: submit a canning transfer with Cases + Packs + Loose cans → assert 3 rows across all three tables/categories.
- Integration test: select a `requires_label = true` can with no label → submission blocked client-side; also reject server-side if bypassed.
- Regression test: existing single-variation kegging/canning submissions (1 line) still produce exactly 1 row each, matching current behavior.

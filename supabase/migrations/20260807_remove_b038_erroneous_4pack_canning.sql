-- Remove the erroneous 2026-07-20 canning of B-038 (Pumpkin Ale).
--
-- On 2026-07-20 a canning run was recorded on B-038 (batch 22a9408a) as
-- 180× "Fortnight Pumpkin Ale - 16oz Labeled Can 4-Pack" (variation a2908cf9,
-- 2.9032 BBL) via batch_transfer f64c1511. This was a data-entry mistake and is
-- being fully reversed.
--
-- The run is cleanly reversible — the 180 units never shipped (no
-- export_transactions), were never broken down, and cold storage still holds the
-- full 180. batch_allocations are batch-wide % channel splits (not per-transfer)
-- and are untouched. The separate 2026-07-20 kegging (f8ba1341, 12 BBL / 24 kegs)
-- and the legit 2026-07-17 cannings (002f3a61, f3dc679f) are left intact.
--
-- Footprint removed (all keyed off transfer f64c1511):
--   packaging_stock_adjustments: 4 rows
--     16oz Blank (container)          -720  → restock +720
--     Aluminum lid                    -720  → restock +720
--     Fortnight Pumpkin Ale Label     -720  → restock +720  (stays negative; loose-label tracking)
--     4-Pack (Black) paktech          -180  → restock +180
--   cold_storage_inventory bd833054 (180 on hand)  → deleted
--   batch_schedule_entries 95f675a7 (canning, stamped 2026-07-20) → reverted to planned
--   batch_transfers f64c1511 (2.9032 BBL) → deleted; volume returns to source tank
--     via the derived transfer ledger.
--
-- ⚠️  packaging_stock_adjustments.batch_transfer_id FK is ON DELETE NO ACTION —
-- the adjustment rows MUST be deleted before the transfer or the transfer delete
-- FK-violates and rolls the whole tx back. This migration deletes them first.
--
-- Idempotent: packaging restock is derived from the adjustment rows via
-- DELETE ... RETURNING, so a re-run finds no rows and is a no-op. The schedule
-- revert is guarded on the stamped timestamp. All deletes are naturally idempotent.

begin;

-- 1. Delete the erroneous run's packaging adjustments and reverse their stock
--    deductions in one atomic step (subtracting the negative qty adds it back).
with adj as (
  delete from packaging_stock_adjustments
   where batch_transfer_id = 'f64c1511-e1aa-4878-a0db-d2a4807640b3'
  returning packaging_item_id, quantity
),
restock as (
  select packaging_item_id, sum(quantity) as total_qty
    from adj
   group by packaging_item_id
)
update packaging_items pi
   set stock_quantity = pi.stock_quantity - r.total_qty
  from restock r
 where pi.id = r.packaging_item_id;

-- 2. Remove the cold-storage row created by the erroneous canning.
delete from cold_storage_inventory
 where source_transfer_id = 'f64c1511-e1aa-4878-a0db-d2a4807640b3';

-- 3. Revert the canning schedule entry this run stamped back to planned.
update batch_schedule_entries
   set actual_start = null, actual_end = null, updated_at = now()
 where id = '95f675a7-92d3-4fd8-8158-2aa4a732db14'
   and actual_start = '2026-07-20T00:00:00+00:00';

-- 4. Delete the erroneous canning transfer (adjustments already gone → FK ok).
--    Its 2.9032 BBL returns to source tank 931d2282 via the derived ledger.
delete from batch_transfers
 where id = 'f64c1511-e1aa-4878-a0db-d2a4807640b3';

commit;

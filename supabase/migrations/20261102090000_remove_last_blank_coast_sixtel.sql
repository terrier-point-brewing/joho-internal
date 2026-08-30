-- Remove the last 1/6 keg of Blank Coast IPA from cold storage.
--
-- B-054 (batch 2941289c, Blank Coast IPA, 20 BBL, contract brew 100% to partner
-- 4cb56ba6) was packaged out on 2026-08-26 across four runs and shipped on
-- 2026-08-27. One sixtel was left on hand and is now being removed.
--
-- The sixtel came from batch_transfer b7a045f8 — a 1-unit kegging run recorded
-- 65 seconds after the main 54-unit run (6bca03be) purely to close the batch
-- out. That closing run is where the batch's ENTIRE packaging loss was parked:
--
--   b7a045f8   1 x Fortnight - 1/6 Keg   volume 0.1665826612903226 BBL
--                                        shrinkage 3.74117943548387 BBL
--
-- ⚠️  The shrinkage is why this cannot simply be deleted. batch_exhaustion
-- consumes volume + shrinkage, and the floorplan drains a tank by volume +
-- shrinkage (buildGraphData). B-054 currently sits at remaining_bbl = 4e-16 —
-- exactly exhausted. Deleting b7a045f8 outright would hand 3.9078 BBL back to
-- brite tank 33 and resurrect a completed batch on the floorplan.
--
-- So the removed keg's beer is reclassified as loss and the run's whole
-- volume + shrinkage figure is moved onto the sibling 54-keg run:
--
--   6bca03be   shrinkage 0 → 3.9077620967741926 BBL  (0.1665827 + 3.7411794)
--
-- Volume + shrinkage is held constant, so kegged_bbl drops by one sixtel,
-- shrinkage_bbl rises by the same, consumed_bbl and remaining_bbl are unchanged,
-- B-054 stays exhausted and complete, and tank 33 stays empty.
--
-- Footprint removed:
--   cold_storage_inventory a4482464 (1 on hand)                    → deleted
--   packaging_stock_adjustments 8398d42d (Fortnight 1/6 Keg, -1)   → deleted,
--     packaging_items a64bfe7b restocked -75 → -74. Cost columns are NULL on
--     this row, so no COGS or inventory-valuation entry moves.
--   batch_schedule_entries b343a199 (kegging, 0.167 BBL, auto-created by this
--     run as "Unscheduled additional kegging")                     → deleted
--   batch_transfers b7a045f8                                       → deleted
--
-- Nothing else references it. The keg never shipped: export_transactions for
-- this batch cover the 2026-08-27 shipment only, all with source_transfer_id
-- NULL, so no excise, no invoice line and no allocation credit moves. The recipe
-- has no recipe_square_links and no tap_assignments, so there is no Square count
-- or draft-stat to restate. No accounting period is closed.
--
-- ⚠️  packaging_stock_adjustments.batch_transfer_id FK is ON DELETE NO ACTION —
-- the adjustment row MUST go before the transfer or the transfer delete
-- FK-violates and rolls the whole tx back. This migration deletes it first.
--
-- Idempotent: the restock is derived from the adjustment row via
-- DELETE ... RETURNING, and the shrinkage move reads b7a045f8 through a FROM
-- clause, so once that transfer is gone a re-run matches no rows and no-ops.

begin;

-- 1. Delete the removed keg's packaging adjustment and put its shell back on
--    the shelf in one atomic step (subtracting the negative qty adds it back).
with adj as (
  delete from packaging_stock_adjustments
   where batch_transfer_id = 'b7a045f8-978a-4bd6-bdfb-2b85a2e3cb80'
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

-- 2. Move the closing run's whole volume + shrinkage figure onto the sibling
--    54-keg run BEFORE deleting it, so the batch ledger never sees a gap.
update batch_transfers sib
   set shrinkage_bbl = sib.shrinkage_bbl + src.volume_bbl + src.shrinkage_bbl
  from batch_transfers src
 where sib.id = '6bca03be-7f43-44f0-b4b6-69b31a5c4116'
   and src.id = 'b7a045f8-978a-4bd6-bdfb-2b85a2e3cb80';

-- 3. Remove the cold-storage row. It is keyed (batch_id, variation_id) and
--    covered both sixtel runs; the other 54 units already shipped, so the one
--    unit left on it is exactly the keg being removed.
delete from cold_storage_inventory
 where id = 'a4482464-00bc-4c7e-9bca-a396b6be6141';

-- 4. Drop the kegging schedule entry this run auto-created, so no phantom
--    0.167 BBL packaging stage is left on the Gantt and calendar.
delete from batch_schedule_entries
 where id = 'b343a199-1097-48ad-a274-fbce3bdbd8a3';

-- 5. Delete the closing kegging transfer (adjustment already gone → FK ok).
delete from batch_transfers
 where id = 'b7a045f8-978a-4bd6-bdfb-2b85a2e3cb80';

commit;

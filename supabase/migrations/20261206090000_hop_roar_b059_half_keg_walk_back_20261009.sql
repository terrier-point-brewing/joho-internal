-- Walk four 1/2 kegs of Hop Roar IPA (B-059) back into tank 14 (2026-10-09).
--
-- One-off DATA migration (no schema changes), owner-directed.
--
-- On 2026-10-08 17:59Z the kegging session booked 12 x 1/2 Keg on run
-- 71f943fe. Only 8 were filled; the other 4 (2.0 bbl) are still in the tank.
--
-- This is NOT the volume+shrinkage-constant method used for a miscounted run
-- on an empty tank: the beer never left, so the run's volume_bbl drops
-- 6.0 → 4.0 and the 2.0 bbl goes back to the source tank. shrinkage_bbl (0.92,
-- the run's share of the session loss) is left as recorded.
--
-- That session had drained the tank and auto-completed the batch, so handing
-- the beer back means un-completing it — the same restore undo_transfer_action
-- performs, done by hand because the run predates batch_transfer_actions:
--   batch_tank_assignments   B-059 re-seated in tank 14 (empty since the run)
--   batch_schedule_entries   94e85d5f fermenting entry re-opened at the 2.0 bbl
--                            still in tank; 31ae4d19 kegging entry 6 → 4
--   brew_batches.status      complete → fermenting, and the "Auto: fully
--                            packaged" history row removed
--
-- Footprint of the run that moves with it:
--   cold_storage_inventory 039d7d02   8 → 4. The lot was 12; 4 shipped to
--     contract brewing 14 minutes after kegging (export dbb94c5b) and that
--     shipment is real, so 4 remain on hand.
--   packaging_stock_adjustments a34a786e  -12 → -8, four shells back on the
--     shelf. Cost columns NULL, no COGS moves.
--
-- The contract commitment (e638fa4f) is "open" and stays open. No ingredient
-- reservations were released by the completion, so none are restored.
--
-- ⚠️  Guarded: aborts if anything has moved off what was read on 2026-10-09,
--     so a re-run after later activity fails loudly.
--
-- Square is not written from here; the next inventory push carries it.

begin;

do $$
declare
  b constant uuid := 'd6f41318-0b8d-425f-bc6e-952e96b2ffdc';  -- B-059
begin
  if not exists (select 1 from batch_transfers
                  where id = '71f943fe-e0de-43fe-aa70-18fc1dbdddb1'
                    and batch_id = b and quantity = 12 and volume_bbl = 6) then
    raise exception 'kegging run 71f943fe is not 12 x 1/2 Keg / 6 bbl — re-read before applying';
  end if;
  if (select quantity_on_hand from cold_storage_inventory
       where id = '039d7d02-d02a-4f31-b39d-b624b4e5bae9') is distinct from 8 then
    raise exception 'B-059 1/2 Keg lot is not 8 on hand — re-read before applying';
  end if;
  if (select quantity from packaging_stock_adjustments
       where id = 'a34a786e-2281-4d76-9434-7f8121fd8ac0') is distinct from -12 then
    raise exception 'shell adjustment a34a786e is not -12 — re-read before applying';
  end if;
  if (select status from brew_batches where id = b) is distinct from 'complete' then
    raise exception 'B-059 is no longer complete — re-read before applying';
  end if;
  if exists (select 1 from batch_transfers
              where batch_id = b and transferred_at > '2026-10-08 17:59:33.446311+00') then
    raise exception 'B-059 has ledger activity after the 2026-10-08 kegging session';
  end if;
  if exists (select 1 from batch_tank_assignments
              where released_at is null
                and (tank_id = '1f701c58-d8f0-4458-8817-4e71eeb1ce98' or batch_id = b)) then
    raise exception 'tank 14 is occupied, or B-059 already sits in a tank';
  end if;
end $$;

-- 1. The run itself: 8 x 1/2 Keg = 8 * 1984 / 3968 bbl.
update batch_transfers
   set quantity = 8, volume_bbl = 4
 where id = '71f943fe-e0de-43fe-aa70-18fc1dbdddb1';

-- 2. Cold storage: 8 filled, 4 already shipped.
update cold_storage_inventory
   set quantity_on_hand = 4
 where id = '039d7d02-d02a-4f31-b39d-b624b4e5bae9';

-- 3. Four shells back on the shelf.
update packaging_stock_adjustments
   set quantity = -8
 where id = 'a34a786e-2281-4d76-9434-7f8121fd8ac0';
update packaging_items
   set stock_quantity = stock_quantity + 4
 where id = 'b1acfd81-0397-4c85-93c9-638a0f346373';

-- 4. Schedule: the kegging stage shows what was filled, and the tank stage is
--    open again at what is still in it.
update batch_schedule_entries
   set volume_bbl = 4
 where id = '31ae4d19-ef35-453c-b664-1da285b9b99d';
update batch_schedule_entries
   set actual_end = null, volume_bbl = 2
 where id = '94e85d5f-8b3c-44ad-b74b-c72ce1b8423d';

-- 5. Back on the floorplan.
insert into batch_tank_assignments (batch_id, tank_id)
values ('d6f41318-0b8d-425f-bc6e-952e96b2ffdc', '1f701c58-d8f0-4458-8817-4e71eeb1ce98');

-- 6. Un-complete the batch.
update brew_batches
   set status = 'fermenting'
 where id = 'd6f41318-0b8d-425f-bc6e-952e96b2ffdc';
delete from batch_status_history
 where id = 'aeee2700-2f06-4f31-8372-f3444fb44e8a';

-- ── The ledger must now hold exactly the 2.0 bbl handed back ────────────────
do $$
declare
  remaining numeric;
begin
  select remaining_bbl into remaining from batch_exhaustion
   where batch_id = 'd6f41318-0b8d-425f-bc6e-952e96b2ffdc';
  if abs(remaining - 2) > 0.001 then
    raise exception 'B-059 remaining is % bbl, expected 2.0 — rolling back', remaining;
  end if;
end $$;

commit;

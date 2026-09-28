-- Undo two duplicate kegging runs and true up six keg lines (2026-09-28).
--
-- One-off DATA migration (no schema changes), owner-directed.
--
-- ⚠️  Not safe to re-run blindly: the guards below abort if any lot has moved
--     off the values read on 2026-09-28, so a re-run after later activity fails
--     loudly instead of overwriting it.
--
-- ── Part A: duplicate kegging runs ─────────────────────────────────────────
-- On 2026-09-28 ~14:31Z three kegging runs were entered noted "Packaged 9/25".
-- Two of them re-recorded kegs the 9/25 session had already booked:
--
--   e62573b4  B-020 Oktoberfest        6 x 1/6 Keg  0.9995 bbl  (9/25 run 27eca923)
--   c1fb6120  B-033 Carolina Pale Ale  2 x 1/2 Keg  1.0 bbl     (9/25 run c522ab51)
--
-- The third (73a1f587, B-062 Epic Hazy, 9 x 1/6) is NOT a duplicate — B-062 had
-- no 9/25 kegging recorded — and is left alone.
--
-- These are removed outright, NOT by the volume+shrinkage-constant method used
-- for real keg corrections: the beer never left the tank, so handing the volume
-- back to the source tank is the correction. Both batches still hold an open
-- batch_tank_assignments row in that tank, so no batch reappears on the
-- floorplan; only the tank's ledger volume rises (B-020 +0.9995, B-033 +1.0).
-- The guard at the end proves floorplan occupancy is unchanged.
--
-- Each run carries footprint that goes with it:
--   packaging_stock_adjustments cfaa8b5c (-6 sixtel shells), aaf57667 (-2 half
--     shells) → deleted, shells restocked. Cost columns NULL, no COGS moves.
--     FK is ON DELETE NO ACTION, so these go FIRST.
--   batch_schedule_entries a9d53f0f, 0f2dc901 ("Unscheduled additional
--     kegging") → deleted, so no phantom stage stays on the Gantt.
--   cold_storage_inventory.source_transfer_id → repointed to the 9/25 run.
--   No export_transactions reference either run.
--
-- ── Part B: cold storage count (per owner) ─────────────────────────────────
--   Oktoberfest 1/6   B-020  9 → 3   (the 6 duplicate kegs above)
--   Wiggo! IPA 1/6    B-035  7 → 6
--   Hop Roar IPA 1/6  B-059  3 → 4   on-hand only; no synthetic kegging run,
--                                     so batch produced-volume is not inflated
--   Watermelon 1/6    B-040 11 → 10
--   Pale Ale 1/2      B-033  1 → 0   the duplicate run added 2; the 9/23 phantom
--                                     sale reconciled today drew 1 of them. Owner
--                                     count is 0, so the lot goes to 0, not -1.
--   Vienna Lager 1/6  B-027  3 → 2
--   Brown Ale 1/6     B-028  8 → 7
--
-- Square is not written from here. The next inventory push (event-driven or
-- nightly) carries the new counts to Square, as cold storage is the source of
-- truth.

begin;

-- ── Guards: abort if anything moved since it was read ───────────────────────
do $$
declare
  expected constant jsonb := jsonb_build_object(
    'febb2564-0c53-4b25-9e9c-fbc1b0df5552', 9,   -- Oktoberfest 1/6 B-020
    '42a19c21-e9ef-43ac-a130-cf0a51a50516', 7,   -- Wiggo 1/6 B-035
    'f90ddf30-02da-4cb5-adfe-341ad62dbe93', 3,   -- Hop Roar 1/6 B-059
    'f7821216-cd22-4afc-b306-2ddee6ddec52', 11,  -- Watermelon 1/6 B-040
    '3ff9edb7-fbb8-431e-bf9a-b169dc23fe8f', 1,   -- Pale Ale 1/2 B-033
    '8d42f856-3f90-4256-9bf7-b5e8cd8eedf6', 3,   -- Vienna 1/6 B-027
    '617921dd-7035-4c60-8d96-433602d0362d', 8    -- Brown Ale 1/6 B-028
  );
  k text;
  actual numeric;
begin
  for k in select jsonb_object_keys(expected) loop
    select quantity_on_hand into actual from cold_storage_inventory where id = k::uuid;
    if actual is distinct from (expected->>k)::numeric then
      raise exception 'cold_storage_inventory % is %, expected % — re-read before applying', k, actual, expected->>k;
    end if;
  end loop;

  if (select count(*) from batch_transfers
       where id in ('e62573b4-bdbb-4887-aebe-6c648f2ec8bc','c1fb6120-acd3-4cde-a5ba-8e6a1cc56dcf')) <> 2 then
    raise exception 'duplicate kegging runs already removed or missing';
  end if;
end $$;

create temp table _floor_before on commit drop as
  select id from batch_tank_assignments where released_at is null;

-- ── Part A ──────────────────────────────────────────────────────────────────
-- 1. Shell adjustments out first (FK), shells back on the shelf.
with adj as (
  delete from packaging_stock_adjustments
   where batch_transfer_id in ('e62573b4-bdbb-4887-aebe-6c648f2ec8bc','c1fb6120-acd3-4cde-a5ba-8e6a1cc56dcf')
  returning packaging_item_id, quantity
),
restock as (
  select packaging_item_id, sum(quantity) as total_qty from adj group by packaging_item_id
)
update packaging_items pi
   set stock_quantity = pi.stock_quantity - r.total_qty
  from restock r
 where pi.id = r.packaging_item_id;

-- 2. Lots point at the surviving 9/25 run.
update cold_storage_inventory set source_transfer_id = '27eca923-c091-4777-9ffb-fdaf990ec599'
 where id = 'febb2564-0c53-4b25-9e9c-fbc1b0df5552';
update cold_storage_inventory set source_transfer_id = 'c522ab51-2cbc-4b6c-8343-1e66d1deec17'
 where id = '3ff9edb7-fbb8-431e-bf9a-b169dc23fe8f';

-- 3. Auto-created schedule entries.
delete from batch_schedule_entries
 where id in ('a9d53f0f-e5ec-4a7d-a321-339d407ef837','0f2dc901-7197-4ea5-a894-1aaacdc59caa');

-- 4. The duplicate runs themselves.
delete from batch_transfers
 where id in ('e62573b4-bdbb-4887-aebe-6c648f2ec8bc','c1fb6120-acd3-4cde-a5ba-8e6a1cc56dcf');

-- ── Part B ──────────────────────────────────────────────────────────────────
update cold_storage_inventory c
   set quantity_on_hand = v.qty
  from (values
    ('febb2564-0c53-4b25-9e9c-fbc1b0df5552'::uuid, 3),
    ('42a19c21-e9ef-43ac-a130-cf0a51a50516'::uuid, 6),
    ('f90ddf30-02da-4cb5-adfe-341ad62dbe93'::uuid, 4),
    ('f7821216-cd22-4afc-b306-2ddee6ddec52'::uuid, 10),
    ('3ff9edb7-fbb8-431e-bf9a-b169dc23fe8f'::uuid, 0),
    ('8d42f856-3f90-4256-9bf7-b5e8cd8eedf6'::uuid, 2),
    ('617921dd-7035-4c60-8d96-433602d0362d'::uuid, 7)
  ) as v(id, qty)
 where c.id = v.id;

-- ── Floorplan must not move ─────────────────────────────────────────────────
do $$
begin
  if exists (
    (select id from batch_tank_assignments where released_at is null
     except select id from _floor_before)
    union all
    (select id from _floor_before
     except select id from batch_tank_assignments where released_at is null)
  ) then
    raise exception 'floorplan occupancy changed — rolling back';
  end if;
end $$;

commit;

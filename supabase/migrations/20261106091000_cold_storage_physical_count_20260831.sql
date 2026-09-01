-- Cold-storage physical inventory reconciliation (2026-08-31).
--
-- One-off DATA migration (no schema changes) that trues up
-- public.cold_storage_inventory to a physical count of the cold room taken on
-- 2026-08-31, and records the one movement the count turned out to be
-- explaining rather than a loss.
--
-- ⚠️  Same hazard as 20260712_cold_storage_physical_reconciliation.sql: this is
--     idempotent, but re-running RESETS these counts to the 2026-08-31 snapshot
--     and will OVERWRITE any legitimate cold-storage movement recorded
--     afterward. Do NOT re-apply to prod without first confirming no newer
--     kegging/canning/ship activity has touched these lines. Kept so a
--     from-scratch rebuild reproduces the reconciled state.
--
-- Why a count was needed at all. cold_storage_inventory has only five writers
-- (packaging +, Export Bay ships −, transforms, pack breaks, refund returns) and
-- no way to state an observed number. Beer that leaves by any other route — a
-- keg rolled onto a tap line with no Draft Restock ring, a packaging run whose
-- cold-storage upsert failed silently — stays on the books forever. The count
-- was taken into the Square Dashboard, which is the only place a person can type
-- one, and the inventory push reversed all 23 lines within hours. The gate is
-- shut while this lands.
--
-- Method (agreed with owner):
--   * The count is per beer and size, so a line spread over several batch lots
--     is drawn down OLDEST LOT FIRST — the order depleteColdStorageInventory
--     already uses, so the write-down takes the same beer a sale would have.
--   * Cans are counted loose and re-seated by the house rule: fill cases (24),
--     then packs (4, or 6 for the Wiggo 12oz line), then leave the remainder
--     loose.
--   * Over-counts are written down / deleted (untracked depletion, not loss).
--     Under-counts are seated as on-hand only — no synthetic kegging/canning
--     transfers, so batch produced-volume is never inflated. Same rule as July.
--   * Vienna Lager was 6 half kegs down and 6 sixtels up. That is two halves
--     split into six sixtels and never logged, so it goes in as a real transform
--     FIRST (below) and only the remaining four halves are written off. Booking
--     it the other way round would charge four barrels of shrinkage that never
--     happened.
--   * Fortnight-labelled stock is a partner label and was outside the scope of
--     the count. Vienna's 38 Fortnight cases stay exactly as they are (still
--     awaiting the shipment flagged in July, and still the largest single line in
--     cold storage). The single Fortnight Pumpkin 4-pack is zeroed on the
--     owner's instruction.
--   * Groundhog Imperial Stout's 21 cans are zeroed: sold out through the
--     taproom, and those sales never reached cold storage.
--   * Orange Pilsner's half keg is RETAINED — present, simply not on the sheet.
--     Carolina Mule's half keg is zeroed.
--   * Transfusion Pilsner is seated at the counted 2 sixtels against B-057. Its
--     in-keg conversion (kegging, quantity 3, packaged_as Transfusion Pilsner)
--     was already recorded on 2026-08-31 17:38:13Z but never produced a
--     cold-storage row — the transfers route swallows that failure. The transfer
--     is the record of production and is left alone; the 1-keg difference is
--     ordinary count variance.
--
-- Net effect: −10.3 bbl of keg beer (21 half kegs, all tap-line sizes) and
-- roughly nil on cans, which net +40 across write-ups and write-downs — cans
-- were mis-seated rather than lost.

-- ── Snapshot before touching anything ───────────────────────────────────────
create table if not exists cold_storage_inventory_bak_20260831 as
  select * from public.cold_storage_inventory;

-- ── The Vienna keg split, booked as the movement it was ─────────────────────
-- 2 x 1/2 Keg (1984 fl oz) -> 6 x 1/6 Keg (661 fl oz). 3968 -> 3966, so 2 fl oz
-- of shrinkage, well inside the half-ounce-per-unit cap on
-- cold_storage_transforms_never_creates_volume. shrinkage_fl_oz is GENERATED
-- ALWAYS and must not be supplied.
insert into public.cold_storage_transforms
  (batch_id, recipe_id, from_variation_id, to_variation_id,
   from_units, to_units, from_volume_fl_oz, to_volume_fl_oz, source_ref, occurred_at, note)
select b.id, r.id, fv.id, tv.id,
       2, 6, fv.total_volume_fl_oz, tv.total_volume_fl_oz,
       'physical-count-20260831',
       timestamptz '2026-08-31 12:00:00+00',
       'Unlogged keg split found by the 2026-08-31 physical count: 6 sixtels on hand against 6 missing half kegs.'
from brew_batches b
join recipes r on r.id = b.recipe_id
join packaging_variations fv on fv.name = '1/2 Keg'
join packaging_variations tv on tv.name = '1/6 Keg'
where b.batch_number = 'B-027'
  and not exists (
    select 1 from public.cold_storage_transforms t
    where t.source_ref = 'physical-count-20260831'
  );

-- ── Absolute on-hand, per batch lot / recipe / variation ────────────────────
-- Every line the count reached, including the ones that did not move, so this
-- reads as a complete statement of the cold room rather than a diff.
with tgt(batch_number, recipe_name, variation_name, qty) as (values
  -- KEGS ────────────────────────────────────────────────────────────────────
  ('B-050','BBA Imperial Stout (Russell''s Reserve 8-Yr)','1/4 Keg',2),
  ('B-052','Winter Porter','1/4 Keg',1),
  ('B-025','Pace Yourself Pilsner','1/6 Keg',1),
  ('B-042','Pace Yourself Pilsner','1/4 Keg',3),
  ('B-034','Epic Hazy IPA','1/6 Keg',3),
  ('B-029','Epic Hazy IPA','1/4 Keg',2),   -- 3 -> 2, oldest lot drawn first
  ('B-045','Epic Hazy IPA','1/4 Keg',1),
  ('B-022','Carolina Pale Ale','1/6 Keg',16),
  ('B-022','Carolina Pale Ale','1/4 Keg',1),
  ('B-028','Carolina Brown Ale','1/6 Keg',11),
  ('B-027','Carolina Vienna Lager','1/6 Keg',20),  -- 14 + 6 from the transform
  ('B-027','Carolina Vienna Lager','1/2 Keg',8),   -- 14 - 2 transformed - 4 lost
  ('B-057','Transfusion Pilsner','1/6 Keg',2),
  ('B-032','Hop Roar IPA','1/4 Keg',3),
  ('B-040','Salted Watermelon Gose','1/2 Keg',4),
  ('B-040','Salted Watermelon Gose','1/6 Keg',11),
  ('B-030','Blackberry Lemon Wheat','1/6 Keg',8),
  ('B-023','Carolina Wheat Wave','1/6 Keg',9),
  ('B-020','Oktoberfest','1/6 Keg',1),
  ('B-057','Carolina Mule','1/6 Keg',6),
  ('B-038','Reaper''s Harvest','1/6 Keg',9),
  ('B-035','Wiggo! IPA','1/6 Keg',11),
  ('B-049','Coffee Epic','1/2 Keg',1),
  ('B-056','Orange Pilsner','1/2 Keg',1),           -- retained: present, uncounted

  -- CANS ────────────────────────────────────────────────────────────────────
  -- Carolina Pale Ale · 176 = 7 cases + 2 four-packs
  ('B-033','Carolina Pale Ale','CBC Carolina Pale Ale - 16oz Printed Can Case',7),
  ('B-033','Carolina Pale Ale','CBC Carolina Pale Ale - 16oz Printed Can 4-Pack',2),
  -- Castle Ruins Brown Ale · 33 = 1 case + 2 four-packs + 1 loose
  ('B-028','Carolina Brown Ale','CBC Castle Ruins Brown Ale - 16oz Labeled Can Case',1),
  ('B-028','Carolina Brown Ale','CBC Castle Ruins Brown Ale - 16oz Labeled Can 4-Pack',2),
  ('B-028','Carolina Brown Ale','CBC Castle Ruins Brown Ale - 16oz Labeled Can',1),
  -- Pumpkin Ale · 93 = 3 cases + 5 four-packs + 1 loose
  ('B-038','Reaper''s Harvest','CBC Pumpkin Reaper Ale - 16oz Labeled Can Case',3),
  ('B-038','Reaper''s Harvest','CBC Pumpkin Reaper Ale - 16oz Labeled Can 4-Pack',5),
  ('B-038','Reaper''s Harvest','CBC Pumpkin Reaper Ale - 16oz Labeled Can',1),
  -- Oktoberfest · 62 = 2 cases + 3 four-packs + 2 loose
  ('B-020','Oktoberfest','CBC Oktoberfest - 16oz Labeled Can Case',2),
  ('B-020','Oktoberfest','CBC Oktoberfest - 16oz Labeled Can 4-Pack',3),
  ('B-020','Oktoberfest','CBC Oktoberfest - 16oz Labeled Can',2),
  -- Wiggo! IPA · 258 = 10 cases + 3 six-packs (12oz line packs in sixes)
  ('B-035','Wiggo! IPA','CBC Wiggo! IPA - 12oz Labeled Can Case',10),
  ('B-035','Wiggo! IPA','CBC Wiggo! IPA - 12oz Labeled Can 6-Pack',3),
  -- BBA Groundhog · 68 = 2 cases + 5 four-packs
  ('B-050','BBA Imperial Stout (Russell''s Reserve 8-Yr)','CBC BBA Groundhog Imperial Stout - 12oz Labeled Can Case',2),
  ('B-050','BBA Imperial Stout (Russell''s Reserve 8-Yr)','CBC BBA Groundhog Imperial Stout - 12oz Labeled Can 4-Pack',5),
  -- Epic Hazy IPA · 258, all seated in the LABELED family per the owner; the
  -- printed line is zeroed below.
  ('B-034','Epic Hazy IPA','CBC Epic Hazy IPA - 16oz Labeled Can Case',10),
  ('B-034','Epic Hazy IPA','CBC Epic Hazy IPA - 16oz Labeled Can 4-Pack',4),
  ('B-034','Epic Hazy IPA','CBC Epic Hazy IPA - 16oz Labeled Can',2),
  -- Be Like Mike · 96 = 4 cases exactly
  ('B-045','Epic Hazy IPA','CBC Be Like Mike IPA - 16oz Labeled Can Case',4),
  -- Hop Roar IPA · 56 = 2 cases + 2 four-packs
  ('B-046','Hop Roar IPA','CBC Hop Roar IPA - 16oz Printed Can Case',2),
  ('B-046','Hop Roar IPA','CBC Hop Roar IPA - 16oz Printed Can 4-Pack',2),
  -- Pace Yourself Pilsner · 84 = 3 cases + 3 four-packs
  ('B-025','Pace Yourself Pilsner','CBC Pace Yourself Pilsner - 16oz Printed Can Case',3),
  ('B-025','Pace Yourself Pilsner','CBC Pace Yourself Pilsner - 16oz Printed Can 4-Pack',3),
  -- Spring Bock · 24 = 1 case (already correct)
  ('B-051','Spring Bock','CBC Spring Bock - 16oz Labeled Can Case',1),
  -- Blackberry Lemon Wheat · 77 = 3 cases + 1 four-pack + 1 loose
  ('B-030','Blackberry Lemon Wheat','CBC Blackberry Lemon Wheat - 16oz Labeled Can Case',3),
  ('B-030','Blackberry Lemon Wheat','CBC Blackberry Lemon Wheat - 16oz Labeled Can 4-Pack',1),
  ('B-030','Blackberry Lemon Wheat','CBC Blackberry Lemon Wheat - 16oz Labeled Can',1),
  -- Vienna Lager · 44 = 1 case + 5 four-packs
  ('B-047','Carolina Vienna Lager','CBC Vienna Lager - 16oz Labeled Can Case',1),
  ('B-047','Carolina Vienna Lager','CBC Vienna Lager - 16oz Labeled Can 4-Pack',5),
  -- Watermelon Gose · 92 = 3 cases + 5 four-packs
  ('B-040','Salted Watermelon Gose','CBC Watermelon Gose - 16oz Labeled Can Case',3),
  ('B-040','Salted Watermelon Gose','CBC Watermelon Gose - 16oz Labeled Can 4-Pack',5),
  -- Partner label, deliberately untouched by the count
  ('B-027','Carolina Vienna Lager','Fortnight Carolina Amber Ale - 16oz Labeled Can Case',38)
),
res as (
  -- beer_name is matched trimmed: 'Oktoberfest ' carries a trailing space in
  -- prod, and trim(beer_name) is unique across recipes.
  select b.id as batch_id, r.id as recipe_id, pv.id as variation_id, t.qty::numeric as qty
  from tgt t
  join brew_batches b on b.batch_number = t.batch_number
  join recipes r on trim(r.beer_name) = t.recipe_name
  join packaging_variations pv on pv.name = t.variation_name
),
upd as (
  update public.cold_storage_inventory csi
     set quantity_on_hand = res.qty, recipe_id = res.recipe_id
    from res
   where csi.batch_id = res.batch_id
     and csi.variation_id = res.variation_id
     and csi.recipe_id is not distinct from res.recipe_id
  returning csi.batch_id, csi.variation_id, csi.recipe_id
)
insert into public.cold_storage_inventory (batch_id, recipe_id, variation_id, quantity_on_hand)
select res.batch_id, res.recipe_id, res.variation_id, res.qty
from res
where not exists (
  select 1 from upd u
  where u.batch_id = res.batch_id
    and u.variation_id = res.variation_id
    and u.recipe_id is not distinct from res.recipe_id
);

-- ── Lines the count has at zero ─────────────────────────────────────────────
-- Deleted rather than set to 0 so they stop appearing in the Export Bay as
-- pickable stock, matching how July handled the same case.
with del(batch_number, recipe_name, variation_name) as (values
  -- 21 half kegs, all tap-line sizes, gone with no Draft Restock ring behind them
  ('B-022','Carolina Pale Ale','1/2 Keg'),
  ('B-035','Wiggo! IPA','1/2 Keg'),
  ('B-057','Carolina Mule','1/2 Keg'),
  -- oldest Carolina Pale Ale sixtel lot, drawn down first
  ('B-044','Carolina Pale Ale','1/6 Keg'),
  -- Epic Hazy printed cans: the counted 258 all seat in the labeled family
  ('B-029','Epic Hazy IPA','CBC Epic Hazy IPA - 16oz Printed Can'),
  -- Be Like Mike counted at exactly 4 sealed cases
  ('B-045','Epic Hazy IPA','CBC Be Like Mike IPA - 16oz Labeled Can 4-Pack'),
  ('B-045','Epic Hazy IPA','CBC Be Like Mike IPA - 16oz Labeled Can'),
  -- Wiggo counted at exactly 10 cases + 3 six-packs
  ('B-035','Wiggo! IPA','CBC Wiggo! IPA - 12oz Labeled Can'),
  -- sold out through the taproom; those sales never reached cold storage
  ('B-053','Groundhog Imperial Stout','CBC Groundhog Imperial Stout - 12oz Labeled Can'),
  ('B-053','Groundhog Imperial Stout','CBC Groundhog Imperial Stout - 12oz Labeled Can 4-Pack'),
  -- partner label, zeroed on the owner's instruction
  ('B-038','Reaper''s Harvest','Fortnight Pumpkin Ale - 16oz Labeled Can 4-Pack')
)
delete from public.cold_storage_inventory csi
using del d
join brew_batches b on b.batch_number = d.batch_number
join recipes r on trim(r.beer_name) = d.recipe_name
join packaging_variations pv on pv.name = d.variation_name
where csi.batch_id = b.id
  and csi.variation_id = pv.id
  and csi.recipe_id is not distinct from r.id;


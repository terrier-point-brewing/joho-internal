-- Cold-storage physical inventory reconciliation (2026-07-04).
--
-- One-off DATA migration (no schema changes) that trues up
-- public.cold_storage_inventory to a physical count of the cold room taken
-- during the ownership transition. Recorded here for auditability; it was
-- applied directly to prod on 2026-07-04 after snapshotting the table into
-- cold_storage_inventory_bak_20260704 / brew_batches_bak_20260704.
--
-- ⚠️  ALREADY APPLIED TO PROD on 2026-07-04. It is idempotent, but re-running
--     RESETS these counts to the 2026-07-04 snapshot and will OVERWRITE any
--     legitimate cold-storage movements recorded afterward. Do NOT re-apply to
--     prod without first confirming no newer kegging/canning/ship activity has
--     touched these recipe+variation lines. Kept purely so a from-scratch
--     rebuild reproduces the reconciled state; filename is dated 20260712 so it
--     sorts AFTER the packaging-variation migrations (20260707) it depends on.
--
-- Method (agreed with owner):
--   * cold_storage_inventory is the Export Bay's "available" source of truth;
--     its only writers are kegging/canning transfers (+) and Export Bay ships (-).
--     Taproom draft and the ownership-transition hand-off never drew it down, so
--     recorded on-hand ran high. We correct the COUNT table only (no synthetic
--     kegging/canning transfers), so batch produced-volume is never inflated.
--   * Over-counts are written down / deleted (untracked depletion, not loss).
--   * Cans physically present but never canned in the ledger are seated as
--     on-hand only (accepted cosmetic gap vs. batch_transfers).
--   * Four orphaned lots (recipe_id NULL, invisible to Export Bay) are relinked
--     (Coffee Epic) or zeroed (Hop Roar / Vienna half-kegs) per the count.
--   * Recipes with no batch (Winter Porter, Groundhog IS, BBA Groundhog,
--     Spring Bock) get a placeholder "complete" batch to hang stock on.
--   * Vienna "Fortnight - 1/6 Keg" x40 intentionally retained (pending a
--     manually-created export shipment).
--
-- Idempotent: absolute-quantity upserts + guarded placeholder inserts + deletes,
-- so re-running converges to the same state.

-- ── Coffee Epic: correct real brew size to cover the counted volume ──────────
update brew_batches set volume_bbl = 1.6 where batch_number = 'B-049';

-- ── Placeholder complete batches for recipes with no batch (20 bbl / 1 turn) ─
insert into brew_batches (beer_name, recipe_id, planned_brew_date, volume_bbl, turns, status, notes)
select r.beer_name, r.id, date '2026-07-04', 20, 1, 'complete', 'Inventory reconciliation placeholder 2026-07-04'
from recipes r
where r.beer_name in ('Winter Porter','Groundhog Imperial Stout','BBA Groundhog (Russell''s Reserve 8-Yr)','Spring Bock')
  and not exists (
    select 1 from brew_batches b
    where b.recipe_id = r.id and b.notes = 'Inventory reconciliation placeholder 2026-07-04'
  );

-- ── Upsert absolute on-hand for existing-batch lines (and relink recipe_id) ──
with tgt(recipe_name, batch_number, variation_name, qty) as (values
  ('Epic Hazy IPA','B-045','1/2 Keg',1),
  ('Epic Hazy IPA','B-029','1/4 Keg',4),
  ('Epic Hazy IPA','B-045','1/4 Keg',1),
  ('Epic Hazy IPA','B-029','1/6 Keg',10),
  ('Epic Hazy IPA','B-029','CBC Epic Hazy IPA - 16oz Printed Can',8),
  ('Epic Hazy IPA','B-045','CBC Epic Hazy IPA - 16oz Printed Can Case',5),
  ('Epic Hazy IPA','B-045','CBC Be Like Mike IPA - 16oz Labeled Can Case',10),
  ('Carolina Pale Ale','B-044','1/2 Keg',1),
  ('Carolina Pale Ale','B-044','1/6 Keg',7),
  ('Carolina Pale Ale','B-022','CBC Carolina Pale Ale - 16oz Printed Can Case',5),
  ('Blackberry Lemon Wheat','B-030','1/2 Keg',1),
  ('Blackberry Lemon Wheat','B-030','1/4 Keg',1),
  ('Blackberry Lemon Wheat','B-030','1/6 Keg',10),
  ('Blackberry Lemon Wheat','B-030','CBC Blackberry Lemon Wheat - 16oz Labeled Can',8),
  ('Blackberry Lemon Wheat','B-030','CBC Blackberry Lemon Wheat - 16oz Labeled Can Case',1),
  ('Pace Yourself Pilsner','B-042','1/2 Keg',4),
  ('Pace Yourself Pilsner','B-042','1/6 Keg',14),
  ('Pace Yourself Pilsner','B-042','CBC Pace Yourself Pilsner - 16oz Printed Can',8),
  ('Pace Yourself Pilsner','B-042','CBC Pace Yourself Pilsner - 16oz Printed Can Case',1),
  ('Coffee Epic','B-049','1/2 Keg',1),
  ('Coffee Epic','B-049','1/4 Keg',3),
  ('Coffee Epic','B-049','1/6 Keg',2),
  ('Carolina Wheat Wave','B-023','1/6 Keg',13),
  ('Vienna Lager','B-027','1/6 Keg',3),
  ('Vienna Lager','B-047','CBC Vienna Lager - 16oz Labeled Can',4),
  ('Vienna Lager','B-047','CBC Vienna Lager - 16oz Labeled Can Case',1),
  ('Hop Roar IPA','B-046','CBC Hop Roar IPA - 16oz Printed Can',12),
  ('Hop Roar IPA','B-046','CBC Hop Roar IPA - 16oz Printed Can Case',1),
  ('Carolina Brown Ale','B-028','CBC Castle Ruins Brown Ale - 16oz Labeled Can Case',1),
  ('Salted Watermelon Gose','B-040','CBC Watermelon Gose - 16oz Labeled Can',12),
  ('Salted Watermelon Gose','B-040','CBC Watermelon Gose - 16oz Labeled Can Case',1)
),
res as (
  select r.id as recipe_id, b.id as batch_id, pv.id as variation_id, t.qty::numeric as qty
  from tgt t
  join recipes r on r.beer_name = t.recipe_name
  join brew_batches b on b.batch_number = t.batch_number
  join packaging_variations pv on pv.name = t.variation_name
),
upd as (
  update cold_storage_inventory csi
     set quantity_on_hand = res.qty, recipe_id = res.recipe_id, updated_at = now()
    from res
   where csi.batch_id = res.batch_id and csi.variation_id = res.variation_id
  returning csi.batch_id, csi.variation_id
)
insert into cold_storage_inventory (batch_id, recipe_id, variation_id, quantity_on_hand)
select res.batch_id, res.recipe_id, res.variation_id, res.qty
from res
where not exists (select 1 from upd u where u.batch_id = res.batch_id and u.variation_id = res.variation_id);

-- ── Seat physical stock onto the placeholder batches ────────────────────────
with ph as (
  select b.id as batch_id, b.recipe_id, r.beer_name
  from brew_batches b
  join recipes r on r.id = b.recipe_id
  where b.notes = 'Inventory reconciliation placeholder 2026-07-04'
),
tgt(recipe_name, variation_name, qty) as (values
  ('Winter Porter','1/4 Keg',2),
  ('Winter Porter','1/6 Keg',2),
  ('Groundhog Imperial Stout','1/6 Keg',1),
  ('BBA Groundhog (Russell''s Reserve 8-Yr)','CBC BBA Groundhog Imperial Stout - 12oz Labeled Can Case',1),
  ('Spring Bock','CBC Spring Bock - 16oz Labeled Can',4),
  ('Spring Bock','CBC Spring Bock - 16oz Labeled Can Case',1)
),
res as (
  select ph.batch_id, ph.recipe_id, pv.id as variation_id, t.qty::numeric as qty
  from tgt t
  join ph on ph.beer_name = t.recipe_name
  join packaging_variations pv on pv.name = t.variation_name
),
upd as (
  update cold_storage_inventory csi
     set quantity_on_hand = res.qty, recipe_id = res.recipe_id, updated_at = now()
    from res
   where csi.batch_id = res.batch_id and csi.variation_id = res.variation_id
  returning csi.batch_id, csi.variation_id
)
insert into cold_storage_inventory (batch_id, recipe_id, variation_id, quantity_on_hand)
select res.batch_id, res.recipe_id, res.variation_id, res.qty
from res
where not exists (select 1 from upd u where u.batch_id = res.batch_id and u.variation_id = res.variation_id);

-- ── Delete lots the physical count has at zero (untracked depletion) ─────────
with del(recipe_name, batch_number, variation_name) as (values
  ('Pace Yourself Pilsner','B-042','1/4 Keg'),
  ('Vienna Lager','B-027','1/2 Keg'),
  ('Vienna Lager','B-047','1/2 Keg'),
  ('Vienna Lager','B-047','1/6 Keg'),
  ('Hop Roar IPA','B-046','1/2 Keg'),
  ('Hop Roar IPA','B-046','1/6 Keg'),
  ('Carolina Brown Ale','B-028','1/6 Keg'),
  ('Salted Watermelon Gose','B-040','1/6 Keg')
)
delete from cold_storage_inventory csi
using del d
join recipes r on r.beer_name = d.recipe_name
join brew_batches b on b.batch_number = d.batch_number
join packaging_variations pv on pv.name = d.variation_name
where csi.batch_id = b.id and csi.variation_id = pv.id;

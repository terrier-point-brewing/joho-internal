-- Restore Vienna Lager B-027 kegs accidentally removed from cold storage (2026-07-04).
--
-- After the 2026-07-04 physical reconciliation (20260712), 3x 1/6 kegs and 3x
-- 1/2 kegs of Vienna Lager (B-027) were accidentally removed from the cold room
-- and dropped out of the count. This adds them back. Corrects
-- cold_storage_inventory only (no synthetic kegging transfers), matching the
-- reconciliation's method so batch produced-volume is never inflated.
--
-- ⚠️  ALREADY APPLIED TO PROD on 2026-07-04.
--
-- Reconciliation left B-027 at: 1/6 Keg = 3, 1/2 Keg = 0 (row deleted).
-- Target after this correction:  1/6 Keg = 6, 1/2 Keg = 3.
--
-- Idempotent: absolute-quantity upserts, so re-running converges to the same
-- state. Filename dated 20260713 to sort AFTER the 20260712 reconciliation it
-- corrects.

with tgt(variation_name, qty) as (values
  ('1/6 Keg', 6),
  ('1/2 Keg', 3)
),
res as (
  select b.id as batch_id, b.recipe_id, pv.id as variation_id, t.qty::numeric as qty
  from tgt t
  join brew_batches b on b.batch_number = 'B-027'
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

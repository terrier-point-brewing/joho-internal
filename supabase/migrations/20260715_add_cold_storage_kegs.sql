-- Stock cold storage with 1/6 kegs for three house draft beers (2026-07-05).
--
-- Adds on-hand 1/6 kegs so the per-tap "keg to drain" dropdown (Configure Taps)
-- has real cold-storage lots to select after the deterministic-draft-swap change:
--   Salted Watermelon Gose (B-040): 13x 1/6 Keg
--   Carolina Brown Ale     (B-028): 10x 1/6 Keg
--   Spring Bock            (B-051):  1x 1/6 Keg
--
-- Corrects cold_storage_inventory only (no synthetic kegging transfers), matching
-- the 20260713 Vienna restore's method so batch produced-volume is never inflated.
-- Uses the shared generic '1/6 Keg' packaging variation (exact-name match excludes
-- the partner-prefixed 1/6 keg SKUs).
--
-- Idempotent: absolute-quantity upsert keyed by (batch_id, variation_id), so
-- re-running converges to the same state. On a DB without these batches the CTE
-- selects nothing and it is a no-op.

with tgt(batch_number, qty) as (values
  ('B-040', 13),
  ('B-028', 10),
  ('B-051', 1)
),
res as (
  select b.id as batch_id, b.recipe_id, pv.id as variation_id, t.qty::numeric as qty
  from tgt t
  join public.brew_batches b on b.batch_number = t.batch_number
  join public.packaging_variations pv on pv.name = '1/6 Keg'
),
upd as (
  update public.cold_storage_inventory csi
     set quantity_on_hand = res.qty, recipe_id = res.recipe_id, updated_at = now()
    from res
   where csi.batch_id = res.batch_id and csi.variation_id = res.variation_id
  returning csi.batch_id, csi.variation_id
)
insert into public.cold_storage_inventory (batch_id, recipe_id, variation_id, quantity_on_hand)
select res.batch_id, res.recipe_id, res.variation_id, res.qty
from res
where not exists (select 1 from upd u where u.batch_id = res.batch_id and u.variation_id = res.variation_id);

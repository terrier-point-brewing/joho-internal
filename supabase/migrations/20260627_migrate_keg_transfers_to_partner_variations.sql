-- Migrates batch_transfers and cold_storage_inventory for Fortnight and Local Time
-- keg batches from generic keg variations (1/2 Keg, 1/4 Keg, 1/6 Keg) to
-- partner-specific variations, traced through batch → recipe → beer_name.

with mapping (recipe_name, old_variation, new_variation) as (values
  ('Blank Coast IPA',             '1/2 Keg', 'Fortnight Blank Coast IPA - 1/2 Keg'),
  ('Blank Coast IPA',             '1/4 Keg', 'Fortnight Blank Coast IPA - 1/4 Keg'),
  ('Blank Coast IPA',             '1/6 Keg', 'Fortnight Blank Coast IPA - 1/6 Keg'),
  ('Mash Pit International Lager','1/2 Keg', 'Fortnight Mash Pit Lager - 1/2 Keg'),
  ('Mash Pit International Lager','1/4 Keg', 'Fortnight Mash Pit Lager - 1/4 Keg'),
  ('Mash Pit International Lager','1/6 Keg', 'Fortnight Mash Pit Lager - 1/6 Keg'),
  ('Local Time Vienna Lager',     '1/2 Keg', 'Local Time Vienna Lager - 1/2 Keg'),
  ('Local Time Vienna Lager',     '1/4 Keg', 'Local Time Vienna Lager - 1/4 Keg'),
  ('Local Time Vienna Lager',     '1/6 Keg', 'Local Time Vienna Lager - 1/6 Keg')
)
update public.batch_transfers bt
set variation_id = new_pv.id
from public.brew_batches bb
join public.recipes r        on r.id = bb.recipe_id
join mapping m               on m.recipe_name = r.beer_name
join public.packaging_variations old_pv on old_pv.name = m.old_variation
join public.packaging_variations new_pv on new_pv.name = m.new_variation
where bt.batch_id    = bb.id
  and bt.variation_id = old_pv.id;

with mapping (recipe_name, old_variation, new_variation) as (values
  ('Blank Coast IPA',             '1/2 Keg', 'Fortnight Blank Coast IPA - 1/2 Keg'),
  ('Blank Coast IPA',             '1/4 Keg', 'Fortnight Blank Coast IPA - 1/4 Keg'),
  ('Blank Coast IPA',             '1/6 Keg', 'Fortnight Blank Coast IPA - 1/6 Keg'),
  ('Mash Pit International Lager','1/2 Keg', 'Fortnight Mash Pit Lager - 1/2 Keg'),
  ('Mash Pit International Lager','1/4 Keg', 'Fortnight Mash Pit Lager - 1/4 Keg'),
  ('Mash Pit International Lager','1/6 Keg', 'Fortnight Mash Pit Lager - 1/6 Keg'),
  ('Local Time Vienna Lager',     '1/2 Keg', 'Local Time Vienna Lager - 1/2 Keg'),
  ('Local Time Vienna Lager',     '1/4 Keg', 'Local Time Vienna Lager - 1/4 Keg'),
  ('Local Time Vienna Lager',     '1/6 Keg', 'Local Time Vienna Lager - 1/6 Keg')
)
update public.cold_storage_inventory csi
set variation_id = new_pv.id
from public.brew_batches bb
join public.recipes r        on r.id = bb.recipe_id
join mapping m               on m.recipe_name = r.beer_name
join public.packaging_variations old_pv on old_pv.name = m.old_variation
join public.packaging_variations new_pv on new_pv.name = m.new_variation
where csi.batch_id    = bb.id
  and csi.variation_id = old_pv.id;

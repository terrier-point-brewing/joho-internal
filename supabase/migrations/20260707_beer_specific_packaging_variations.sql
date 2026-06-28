-- Beer-specific packaging variations for 17 contract-brewed beers.
-- Creates 13 labeled-can packaging_items, 51 packaging_variations
-- (17 beers × loose + 4-pack/6-pack + case), links all variations to
-- their recipes, and migrates existing generic-variation records in
-- batch_transfers and cold_storage_inventory.

-- ─── Step 1: Label packaging items ───────────────────────────────────────────
insert into public.packaging_items (name, type) values
  ('CBC Vienna Lager Label',                    'label'),
  ('CBC Blackberry Lemon Wheat Label',          'label'),
  ('CBC Spring Bock Label',                     'label'),
  ('CBC Watermelon Gose Label',                 'label'),
  ('CBC Castle Ruins Brown Ale Label',          'label'),
  ('CBC Be Like Mike IPA Label',                'label'),
  ('Fortnight Mash Pit Lager Label',            'label'),
  ('Fortnight Blank Coast IPA Label',           'label'),
  ('Fortnight Pumpkin Ale Label',               'label'),
  ('Local Time Vienna Lager Label',             'label'),
  ('CBC Groundhog Imperial Stout Label',        'label'),
  ('CBC BBA Groundhog Imperial Stout Label',    'label'),
  ('CBC Wiggo! IPA Label',                      'label');

-- ─── Step 2: 51 packaging variations ─────────────────────────────────────────
-- Naming: "{prefix} - {size} {Printed|Labeled} Can[ 4-Pack| 6-Pack| Case]"
-- total_volume_fl_oz = container.volume_fl_oz * package_unit_count:
--   loose → 1, 4-pack → 4, 6-pack → 6, case → 24 (Blank Tray can_count)
-- null::uuid casts required for UNION ALL type resolution.

with c as (
  select
    (select id from public.packaging_items where name = '16oz Blank'        and type = 'can')    as c16,
    (select id from public.packaging_items where name = '12oz Blank'        and type = 'can')    as c12,
    (select id from public.packaging_items where name = 'Aluminum (Silver)' and type = 'lid')    as lid,
    (select id from public.packaging_items where name = '4-Pack (Black)'    and type = 'paktech') as pk4,
    (select id from public.packaging_items where name = '6-Pack (Black)'    and type = 'paktech') as pk6,
    (select id from public.packaging_items where name = 'Blank Tray'        and type = 'tray')   as tray,
    (select id from public.contract_brewing_partners where company_name = 'Argus Beverage Ventures LLC') as argus,
    (select id from public.contract_brewing_partners where company_name = 'Fortnight Brewing')           as ftnight,
    (select id from public.contract_brewing_partners where company_name = 'Local Time Brewing')          as lt,
    -- label items (inserted above; visible within this transaction)
    (select id from public.packaging_items where name = 'CBC Vienna Lager Label'                 and type = 'label') as lbl_vienna,
    (select id from public.packaging_items where name = 'CBC Blackberry Lemon Wheat Label'       and type = 'label') as lbl_blk,
    (select id from public.packaging_items where name = 'CBC Spring Bock Label'                  and type = 'label') as lbl_sbock,
    (select id from public.packaging_items where name = 'CBC Watermelon Gose Label'              and type = 'label') as lbl_wgose,
    (select id from public.packaging_items where name = 'CBC Castle Ruins Brown Ale Label'       and type = 'label') as lbl_crba,
    (select id from public.packaging_items where name = 'CBC Be Like Mike IPA Label'             and type = 'label') as lbl_blm,
    (select id from public.packaging_items where name = 'Fortnight Mash Pit Lager Label'         and type = 'label') as lbl_mp,
    (select id from public.packaging_items where name = 'Fortnight Blank Coast IPA Label'        and type = 'label') as lbl_bc,
    (select id from public.packaging_items where name = 'Fortnight Pumpkin Ale Label'            and type = 'label') as lbl_fpump,
    (select id from public.packaging_items where name = 'Local Time Vienna Lager Label'          and type = 'label') as lbl_ltvl,
    (select id from public.packaging_items where name = 'CBC Groundhog Imperial Stout Label'     and type = 'label') as lbl_ghs,
    (select id from public.packaging_items where name = 'CBC BBA Groundhog Imperial Stout Label' and type = 'label') as lbl_bba,
    (select id from public.packaging_items where name = 'CBC Wiggo! IPA Label'                  and type = 'label') as lbl_wiggo,
    -- volume/count for total_volume_fl_oz computation
    (select volume_fl_oz from public.packaging_items where name = '16oz Blank' and type = 'can')            as vol16,
    (select volume_fl_oz from public.packaging_items where name = '12oz Blank' and type = 'can')            as vol12,
    (select can_count    from public.packaging_items where name = '4-Pack (Black)' and type = 'paktech')    as cnt4,
    (select can_count    from public.packaging_items where name = '6-Pack (Black)' and type = 'paktech')    as cnt6,
    (select can_count    from public.packaging_items where name = 'Blank Tray'     and type = 'tray')       as cnt_case
)
insert into public.packaging_variations
  (container_id, format, lid_id, paktech_id, tray_id, label_id, partner_id, name, total_volume_fl_oz)
-- ── 1. CBC Epic Hazy IPA — 16oz Printed Can ──────────────────────────────────
select c16,'loose', lid,null::uuid,null::uuid,null::uuid,argus,'CBC Epic Hazy IPA - 16oz Printed Can',       vol16*1        from c union all
select c16,'4-pack',lid,pk4,       null::uuid,null::uuid,argus,'CBC Epic Hazy IPA - 16oz Printed Can 4-Pack',vol16*cnt4     from c union all
select c16,'case',  lid,null::uuid,tray,      null::uuid,argus,'CBC Epic Hazy IPA - 16oz Printed Can Case',  vol16*cnt_case from c union all
-- ── 2. CBC Hop Roar IPA ──────────────────────────────────────────────────────
select c16,'loose', lid,null::uuid,null::uuid,null::uuid,argus,'CBC Hop Roar IPA - 16oz Printed Can',       vol16*1        from c union all
select c16,'4-pack',lid,pk4,       null::uuid,null::uuid,argus,'CBC Hop Roar IPA - 16oz Printed Can 4-Pack',vol16*cnt4     from c union all
select c16,'case',  lid,null::uuid,tray,      null::uuid,argus,'CBC Hop Roar IPA - 16oz Printed Can Case',  vol16*cnt_case from c union all
-- ── 3. CBC Pace Yourself Pilsner ─────────────────────────────────────────────
select c16,'loose', lid,null::uuid,null::uuid,null::uuid,argus,'CBC Pace Yourself Pilsner - 16oz Printed Can',       vol16*1        from c union all
select c16,'4-pack',lid,pk4,       null::uuid,null::uuid,argus,'CBC Pace Yourself Pilsner - 16oz Printed Can 4-Pack',vol16*cnt4     from c union all
select c16,'case',  lid,null::uuid,tray,      null::uuid,argus,'CBC Pace Yourself Pilsner - 16oz Printed Can Case',  vol16*cnt_case from c union all
-- ── 4. CBC Carolina Pale Ale ─────────────────────────────────────────────────
select c16,'loose', lid,null::uuid,null::uuid,null::uuid,argus,'CBC Carolina Pale Ale - 16oz Printed Can',       vol16*1        from c union all
select c16,'4-pack',lid,pk4,       null::uuid,null::uuid,argus,'CBC Carolina Pale Ale - 16oz Printed Can 4-Pack',vol16*cnt4     from c union all
select c16,'case',  lid,null::uuid,tray,      null::uuid,argus,'CBC Carolina Pale Ale - 16oz Printed Can Case',  vol16*cnt_case from c union all
-- ── 5. CBC Vienna Lager — 16oz Labeled Can ───────────────────────────────────
select c16,'loose', lid,null::uuid,null::uuid,lbl_vienna,argus,'CBC Vienna Lager - 16oz Labeled Can',       vol16*1        from c union all
select c16,'4-pack',lid,pk4,       null::uuid,lbl_vienna,argus,'CBC Vienna Lager - 16oz Labeled Can 4-Pack',vol16*cnt4     from c union all
select c16,'case',  lid,null::uuid,tray,      lbl_vienna,argus,'CBC Vienna Lager - 16oz Labeled Can Case',  vol16*cnt_case from c union all
-- ── 6. CBC Blackberry Lemon Wheat ────────────────────────────────────────────
select c16,'loose', lid,null::uuid,null::uuid,lbl_blk,argus,'CBC Blackberry Lemon Wheat - 16oz Labeled Can',       vol16*1        from c union all
select c16,'4-pack',lid,pk4,       null::uuid,lbl_blk,argus,'CBC Blackberry Lemon Wheat - 16oz Labeled Can 4-Pack',vol16*cnt4     from c union all
select c16,'case',  lid,null::uuid,tray,      lbl_blk,argus,'CBC Blackberry Lemon Wheat - 16oz Labeled Can Case',  vol16*cnt_case from c union all
-- ── 7. CBC Spring Bock ───────────────────────────────────────────────────────
select c16,'loose', lid,null::uuid,null::uuid,lbl_sbock,argus,'CBC Spring Bock - 16oz Labeled Can',       vol16*1        from c union all
select c16,'4-pack',lid,pk4,       null::uuid,lbl_sbock,argus,'CBC Spring Bock - 16oz Labeled Can 4-Pack',vol16*cnt4     from c union all
select c16,'case',  lid,null::uuid,tray,      lbl_sbock,argus,'CBC Spring Bock - 16oz Labeled Can Case',  vol16*cnt_case from c union all
-- ── 8. CBC Watermelon Gose ───────────────────────────────────────────────────
select c16,'loose', lid,null::uuid,null::uuid,lbl_wgose,argus,'CBC Watermelon Gose - 16oz Labeled Can',       vol16*1        from c union all
select c16,'4-pack',lid,pk4,       null::uuid,lbl_wgose,argus,'CBC Watermelon Gose - 16oz Labeled Can 4-Pack',vol16*cnt4     from c union all
select c16,'case',  lid,null::uuid,tray,      lbl_wgose,argus,'CBC Watermelon Gose - 16oz Labeled Can Case',  vol16*cnt_case from c union all
-- ── 9. CBC Castle Ruins Brown Ale ────────────────────────────────────────────
select c16,'loose', lid,null::uuid,null::uuid,lbl_crba,argus,'CBC Castle Ruins Brown Ale - 16oz Labeled Can',       vol16*1        from c union all
select c16,'4-pack',lid,pk4,       null::uuid,lbl_crba,argus,'CBC Castle Ruins Brown Ale - 16oz Labeled Can 4-Pack',vol16*cnt4     from c union all
select c16,'case',  lid,null::uuid,tray,      lbl_crba,argus,'CBC Castle Ruins Brown Ale - 16oz Labeled Can Case',  vol16*cnt_case from c union all
-- ── 10. CBC Be Like Mike IPA ─────────────────────────────────────────────────
select c16,'loose', lid,null::uuid,null::uuid,lbl_blm,argus,'CBC Be Like Mike IPA - 16oz Labeled Can',       vol16*1        from c union all
select c16,'4-pack',lid,pk4,       null::uuid,lbl_blm,argus,'CBC Be Like Mike IPA - 16oz Labeled Can 4-Pack',vol16*cnt4     from c union all
select c16,'case',  lid,null::uuid,tray,      lbl_blm,argus,'CBC Be Like Mike IPA - 16oz Labeled Can Case',  vol16*cnt_case from c union all
-- ── 11. Fortnight Mash Pit Lager ─────────────────────────────────────────────
select c16,'loose', lid,null::uuid,null::uuid,lbl_mp,ftnight,'Fortnight Mash Pit Lager - 16oz Labeled Can',       vol16*1        from c union all
select c16,'4-pack',lid,pk4,       null::uuid,lbl_mp,ftnight,'Fortnight Mash Pit Lager - 16oz Labeled Can 4-Pack',vol16*cnt4     from c union all
select c16,'case',  lid,null::uuid,tray,      lbl_mp,ftnight,'Fortnight Mash Pit Lager - 16oz Labeled Can Case',  vol16*cnt_case from c union all
-- ── 12. Fortnight Blank Coast IPA ────────────────────────────────────────────
select c16,'loose', lid,null::uuid,null::uuid,lbl_bc,ftnight,'Fortnight Blank Coast IPA - 16oz Labeled Can',       vol16*1        from c union all
select c16,'4-pack',lid,pk4,       null::uuid,lbl_bc,ftnight,'Fortnight Blank Coast IPA - 16oz Labeled Can 4-Pack',vol16*cnt4     from c union all
select c16,'case',  lid,null::uuid,tray,      lbl_bc,ftnight,'Fortnight Blank Coast IPA - 16oz Labeled Can Case',  vol16*cnt_case from c union all
-- ── 13. Fortnight Pumpkin Ale ────────────────────────────────────────────────
select c16,'loose', lid,null::uuid,null::uuid,lbl_fpump,ftnight,'Fortnight Pumpkin Ale - 16oz Labeled Can',       vol16*1        from c union all
select c16,'4-pack',lid,pk4,       null::uuid,lbl_fpump,ftnight,'Fortnight Pumpkin Ale - 16oz Labeled Can 4-Pack',vol16*cnt4     from c union all
select c16,'case',  lid,null::uuid,tray,      lbl_fpump,ftnight,'Fortnight Pumpkin Ale - 16oz Labeled Can Case',  vol16*cnt_case from c union all
-- ── 14. Local Time Vienna Lager ──────────────────────────────────────────────
select c16,'loose', lid,null::uuid,null::uuid,lbl_ltvl,lt,'Local Time Vienna Lager - 16oz Labeled Can',       vol16*1        from c union all
select c16,'4-pack',lid,pk4,       null::uuid,lbl_ltvl,lt,'Local Time Vienna Lager - 16oz Labeled Can 4-Pack',vol16*cnt4     from c union all
select c16,'case',  lid,null::uuid,tray,      lbl_ltvl,lt,'Local Time Vienna Lager - 16oz Labeled Can Case',  vol16*cnt_case from c union all
-- ── 15. CBC Groundhog Imperial Stout — 12oz Labeled Can ──────────────────────
select c12,'loose', lid,null::uuid,null::uuid,lbl_ghs,argus,'CBC Groundhog Imperial Stout - 12oz Labeled Can',        vol12*1        from c union all
select c12,'6-pack',lid,pk6,       null::uuid,lbl_ghs,argus,'CBC Groundhog Imperial Stout - 12oz Labeled Can 6-Pack', vol12*cnt6     from c union all
select c12,'case',  lid,null::uuid,tray,      lbl_ghs,argus,'CBC Groundhog Imperial Stout - 12oz Labeled Can Case',   vol12*cnt_case from c union all
-- ── 16. CBC BBA Groundhog Imperial Stout ─────────────────────────────────────
select c12,'loose', lid,null::uuid,null::uuid,lbl_bba,argus,'CBC BBA Groundhog Imperial Stout - 12oz Labeled Can',        vol12*1        from c union all
select c12,'6-pack',lid,pk6,       null::uuid,lbl_bba,argus,'CBC BBA Groundhog Imperial Stout - 12oz Labeled Can 6-Pack', vol12*cnt6     from c union all
select c12,'case',  lid,null::uuid,tray,      lbl_bba,argus,'CBC BBA Groundhog Imperial Stout - 12oz Labeled Can Case',   vol12*cnt_case from c union all
-- ── 17. CBC Wiggo! IPA ───────────────────────────────────────────────────────
select c12,'loose', lid,null::uuid,null::uuid,lbl_wiggo,argus,'CBC Wiggo! IPA - 12oz Labeled Can',        vol12*1        from c union all
select c12,'6-pack',lid,pk6,       null::uuid,lbl_wiggo,argus,'CBC Wiggo! IPA - 12oz Labeled Can 6-Pack', vol12*cnt6     from c union all
select c12,'case',  lid,null::uuid,tray,      lbl_wiggo,argus,'CBC Wiggo! IPA - 12oz Labeled Can Case',   vol12*cnt_case from c
;

-- ─── Step 3: Recipe ↔ variation links ────────────────────────────────────────
-- #10 Be Like Mike IPA links to Epic Hazy IPA recipe (same recipe, different
-- label/branding). Pumpkin Ale variations carry Fortnight as partner but link
-- to the Pumpkin Ale recipe (brewed by Argus for Fortnight).

with mapping (recipe_name, recipe_brewery, variation_name) as (values
  -- 1 + 10: Epic Hazy IPA recipe → Printed Can + Be Like Mike variations
  ('Epic Hazy IPA','Argus Beverage Ventures LLC','CBC Epic Hazy IPA - 16oz Printed Can'),
  ('Epic Hazy IPA','Argus Beverage Ventures LLC','CBC Epic Hazy IPA - 16oz Printed Can 4-Pack'),
  ('Epic Hazy IPA','Argus Beverage Ventures LLC','CBC Epic Hazy IPA - 16oz Printed Can Case'),
  ('Epic Hazy IPA','Argus Beverage Ventures LLC','CBC Be Like Mike IPA - 16oz Labeled Can'),
  ('Epic Hazy IPA','Argus Beverage Ventures LLC','CBC Be Like Mike IPA - 16oz Labeled Can 4-Pack'),
  ('Epic Hazy IPA','Argus Beverage Ventures LLC','CBC Be Like Mike IPA - 16oz Labeled Can Case'),
  -- 2
  ('Hop Roar IPA','Argus Beverage Ventures LLC','CBC Hop Roar IPA - 16oz Printed Can'),
  ('Hop Roar IPA','Argus Beverage Ventures LLC','CBC Hop Roar IPA - 16oz Printed Can 4-Pack'),
  ('Hop Roar IPA','Argus Beverage Ventures LLC','CBC Hop Roar IPA - 16oz Printed Can Case'),
  -- 3
  ('Pace Yourself Pilsner','Argus Beverage Ventures LLC','CBC Pace Yourself Pilsner - 16oz Printed Can'),
  ('Pace Yourself Pilsner','Argus Beverage Ventures LLC','CBC Pace Yourself Pilsner - 16oz Printed Can 4-Pack'),
  ('Pace Yourself Pilsner','Argus Beverage Ventures LLC','CBC Pace Yourself Pilsner - 16oz Printed Can Case'),
  -- 4
  ('Carolina Pale Ale','Argus Beverage Ventures LLC','CBC Carolina Pale Ale - 16oz Printed Can'),
  ('Carolina Pale Ale','Argus Beverage Ventures LLC','CBC Carolina Pale Ale - 16oz Printed Can 4-Pack'),
  ('Carolina Pale Ale','Argus Beverage Ventures LLC','CBC Carolina Pale Ale - 16oz Printed Can Case'),
  -- 5
  ('Vienna Lager','Argus Beverage Ventures LLC','CBC Vienna Lager - 16oz Labeled Can'),
  ('Vienna Lager','Argus Beverage Ventures LLC','CBC Vienna Lager - 16oz Labeled Can 4-Pack'),
  ('Vienna Lager','Argus Beverage Ventures LLC','CBC Vienna Lager - 16oz Labeled Can Case'),
  -- 6
  ('Blackberry Lemon Wheat','Argus Beverage Ventures LLC','CBC Blackberry Lemon Wheat - 16oz Labeled Can'),
  ('Blackberry Lemon Wheat','Argus Beverage Ventures LLC','CBC Blackberry Lemon Wheat - 16oz Labeled Can 4-Pack'),
  ('Blackberry Lemon Wheat','Argus Beverage Ventures LLC','CBC Blackberry Lemon Wheat - 16oz Labeled Can Case'),
  -- 7
  ('Spring Bock','Argus Beverage Ventures LLC','CBC Spring Bock - 16oz Labeled Can'),
  ('Spring Bock','Argus Beverage Ventures LLC','CBC Spring Bock - 16oz Labeled Can 4-Pack'),
  ('Spring Bock','Argus Beverage Ventures LLC','CBC Spring Bock - 16oz Labeled Can Case'),
  -- 8: variation "Watermelon Gose" → recipe "Salted Watermelon Gose"
  ('Salted Watermelon Gose','Argus Beverage Ventures LLC','CBC Watermelon Gose - 16oz Labeled Can'),
  ('Salted Watermelon Gose','Argus Beverage Ventures LLC','CBC Watermelon Gose - 16oz Labeled Can 4-Pack'),
  ('Salted Watermelon Gose','Argus Beverage Ventures LLC','CBC Watermelon Gose - 16oz Labeled Can Case'),
  -- 9: variation "Castle Ruins Brown Ale" → recipe "Carolina Brown Ale"
  ('Carolina Brown Ale','Argus Beverage Ventures LLC','CBC Castle Ruins Brown Ale - 16oz Labeled Can'),
  ('Carolina Brown Ale','Argus Beverage Ventures LLC','CBC Castle Ruins Brown Ale - 16oz Labeled Can 4-Pack'),
  ('Carolina Brown Ale','Argus Beverage Ventures LLC','CBC Castle Ruins Brown Ale - 16oz Labeled Can Case'),
  -- 11
  ('Mash Pit International Lager','Fortnight Brewing','Fortnight Mash Pit Lager - 16oz Labeled Can'),
  ('Mash Pit International Lager','Fortnight Brewing','Fortnight Mash Pit Lager - 16oz Labeled Can 4-Pack'),
  ('Mash Pit International Lager','Fortnight Brewing','Fortnight Mash Pit Lager - 16oz Labeled Can Case'),
  -- 12
  ('Blank Coast IPA','Fortnight Brewing','Fortnight Blank Coast IPA - 16oz Labeled Can'),
  ('Blank Coast IPA','Fortnight Brewing','Fortnight Blank Coast IPA - 16oz Labeled Can 4-Pack'),
  ('Blank Coast IPA','Fortnight Brewing','Fortnight Blank Coast IPA - 16oz Labeled Can Case'),
  -- 13: Fortnight partner variations → Pumpkin Ale recipe (brewed by Argus)
  ('Pumpkin Ale','Argus Beverage Ventures LLC','Fortnight Pumpkin Ale - 16oz Labeled Can'),
  ('Pumpkin Ale','Argus Beverage Ventures LLC','Fortnight Pumpkin Ale - 16oz Labeled Can 4-Pack'),
  ('Pumpkin Ale','Argus Beverage Ventures LLC','Fortnight Pumpkin Ale - 16oz Labeled Can Case'),
  -- 14
  ('Local Time Vienna Lager','Local Time Brewing','Local Time Vienna Lager - 16oz Labeled Can'),
  ('Local Time Vienna Lager','Local Time Brewing','Local Time Vienna Lager - 16oz Labeled Can 4-Pack'),
  ('Local Time Vienna Lager','Local Time Brewing','Local Time Vienna Lager - 16oz Labeled Can Case'),
  -- 15
  ('Groundhog Imperial Stout','Argus Beverage Ventures LLC','CBC Groundhog Imperial Stout - 12oz Labeled Can'),
  ('Groundhog Imperial Stout','Argus Beverage Ventures LLC','CBC Groundhog Imperial Stout - 12oz Labeled Can 6-Pack'),
  ('Groundhog Imperial Stout','Argus Beverage Ventures LLC','CBC Groundhog Imperial Stout - 12oz Labeled Can Case'),
  -- 16
  ('BBA Groundhog (Russell''s Reserve 8-Yr)','Argus Beverage Ventures LLC','CBC BBA Groundhog Imperial Stout - 12oz Labeled Can'),
  ('BBA Groundhog (Russell''s Reserve 8-Yr)','Argus Beverage Ventures LLC','CBC BBA Groundhog Imperial Stout - 12oz Labeled Can 6-Pack'),
  ('BBA Groundhog (Russell''s Reserve 8-Yr)','Argus Beverage Ventures LLC','CBC BBA Groundhog Imperial Stout - 12oz Labeled Can Case'),
  -- 17
  ('Wiggo! IPA','Argus Beverage Ventures LLC','CBC Wiggo! IPA - 12oz Labeled Can'),
  ('Wiggo! IPA','Argus Beverage Ventures LLC','CBC Wiggo! IPA - 12oz Labeled Can 6-Pack'),
  ('Wiggo! IPA','Argus Beverage Ventures LLC','CBC Wiggo! IPA - 12oz Labeled Can Case')
)
insert into public.recipe_packaging_variations (recipe_id, variation_id)
select r.id, pv.id
from mapping m
join public.recipes r  on r.beer_name = m.recipe_name and r.brewery = m.recipe_brewery
join public.packaging_variations pv on pv.name = m.variation_name
on conflict (recipe_id, variation_id) do nothing;

-- ─── Step 4: Migrate existing generic-variation records ───────────────────────
-- Traced by batch → recipe to determine the correct beer-specific variation.
-- Only Standard 16oz Can and Standard 16oz Case records are affected.

with recipe_to_variation (recipe_name, old_name, new_name) as (values
  ('Epic Hazy IPA',              'Standard 16oz Can',  'CBC Epic Hazy IPA - 16oz Printed Can'),
  ('Local Time Vienna Lager',    'Standard 16oz Can',  'Local Time Vienna Lager - 16oz Labeled Can'),
  ('Salted Watermelon Gose',     'Standard 16oz Can',  'CBC Watermelon Gose - 16oz Labeled Can'),
  ('Blank Coast IPA',            'Standard 16oz Case', 'Fortnight Blank Coast IPA - 16oz Labeled Can Case'),
  ('Carolina Brown Ale',         'Standard 16oz Case', 'CBC Castle Ruins Brown Ale - 16oz Labeled Can Case'),
  ('Carolina Pale Ale',          'Standard 16oz Case', 'CBC Carolina Pale Ale - 16oz Printed Can Case'),
  ('Epic Hazy IPA',              'Standard 16oz Case', 'CBC Epic Hazy IPA - 16oz Printed Can Case'),
  ('Local Time Vienna Lager',    'Standard 16oz Case', 'Local Time Vienna Lager - 16oz Labeled Can Case'),
  ('Mash Pit International Lager','Standard 16oz Case','Fortnight Mash Pit Lager - 16oz Labeled Can Case'),
  ('Salted Watermelon Gose',     'Standard 16oz Case', 'CBC Watermelon Gose - 16oz Labeled Can Case')
)
update public.batch_transfers bt
set variation_id = new_pv.id
from public.brew_batches bb
join public.recipes r      on r.id = bb.recipe_id
join recipe_to_variation m on m.recipe_name = r.beer_name
join public.packaging_variations old_pv on old_pv.name = m.old_name
join public.packaging_variations new_pv on new_pv.name = m.new_name
where bt.batch_id    = bb.id
  and bt.variation_id = old_pv.id;

with recipe_to_variation (recipe_name, old_name, new_name) as (values
  ('Epic Hazy IPA',              'Standard 16oz Can',  'CBC Epic Hazy IPA - 16oz Printed Can'),
  ('Local Time Vienna Lager',    'Standard 16oz Can',  'Local Time Vienna Lager - 16oz Labeled Can'),
  ('Salted Watermelon Gose',     'Standard 16oz Can',  'CBC Watermelon Gose - 16oz Labeled Can'),
  ('Blank Coast IPA',            'Standard 16oz Case', 'Fortnight Blank Coast IPA - 16oz Labeled Can Case'),
  ('Carolina Brown Ale',         'Standard 16oz Case', 'CBC Castle Ruins Brown Ale - 16oz Labeled Can Case'),
  ('Carolina Pale Ale',          'Standard 16oz Case', 'CBC Carolina Pale Ale - 16oz Printed Can Case'),
  ('Epic Hazy IPA',              'Standard 16oz Case', 'CBC Epic Hazy IPA - 16oz Printed Can Case'),
  ('Local Time Vienna Lager',    'Standard 16oz Case', 'Local Time Vienna Lager - 16oz Labeled Can Case'),
  ('Mash Pit International Lager','Standard 16oz Case','Fortnight Mash Pit Lager - 16oz Labeled Can Case'),
  ('Salted Watermelon Gose',     'Standard 16oz Case', 'CBC Watermelon Gose - 16oz Labeled Can Case')
)
update public.cold_storage_inventory csi
set variation_id = new_pv.id
from public.brew_batches bb
join public.recipes r      on r.id = bb.recipe_id
join recipe_to_variation m on m.recipe_name = r.beer_name
join public.packaging_variations old_pv on old_pv.name = m.old_name
join public.packaging_variations new_pv on new_pv.name = m.new_name
where csi.batch_id   = bb.id
  and csi.variation_id = old_pv.id;

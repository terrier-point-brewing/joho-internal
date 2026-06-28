-- Fixes printed can variations to use beer-specific container items (not blank cans).
-- Adds partner-specific keg items + variations for Fortnight and Local Time,
-- linked to Blank Coast IPA, Mash Pit International Lager, and Local Time Vienna Lager.

-- ─── Step 1: Beer-specific printed can packaging items ────────────────────────
-- Printed cans have artwork printed directly on the can body (not blank + label).
insert into public.packaging_items (name, type, volume_fl_oz) values
  ('CBC Epic Hazy IPA 16oz Can',        'can', 16),
  ('CBC Hop Roar IPA 16oz Can',         'can', 16),
  ('CBC Pace Yourself Pilsner 16oz Can','can', 16),
  ('CBC Carolina Pale Ale 16oz Can',    'can', 16);

-- ─── Step 2: Swap container_id on existing printed can variations ─────────────
update public.packaging_variations pv
set container_id = pi.id
from public.packaging_items pi
where pi.name = 'CBC Epic Hazy IPA 16oz Can' and pi.type = 'can'
  and pv.name in (
    'CBC Epic Hazy IPA - 16oz Printed Can',
    'CBC Epic Hazy IPA - 16oz Printed Can 4-Pack',
    'CBC Epic Hazy IPA - 16oz Printed Can Case'
  );

update public.packaging_variations pv
set container_id = pi.id
from public.packaging_items pi
where pi.name = 'CBC Hop Roar IPA 16oz Can' and pi.type = 'can'
  and pv.name in (
    'CBC Hop Roar IPA - 16oz Printed Can',
    'CBC Hop Roar IPA - 16oz Printed Can 4-Pack',
    'CBC Hop Roar IPA - 16oz Printed Can Case'
  );

update public.packaging_variations pv
set container_id = pi.id
from public.packaging_items pi
where pi.name = 'CBC Pace Yourself Pilsner 16oz Can' and pi.type = 'can'
  and pv.name in (
    'CBC Pace Yourself Pilsner - 16oz Printed Can',
    'CBC Pace Yourself Pilsner - 16oz Printed Can 4-Pack',
    'CBC Pace Yourself Pilsner - 16oz Printed Can Case'
  );

update public.packaging_variations pv
set container_id = pi.id
from public.packaging_items pi
where pi.name = 'CBC Carolina Pale Ale 16oz Can' and pi.type = 'can'
  and pv.name in (
    'CBC Carolina Pale Ale - 16oz Printed Can',
    'CBC Carolina Pale Ale - 16oz Printed Can 4-Pack',
    'CBC Carolina Pale Ale - 16oz Printed Can Case'
  );

-- ─── Step 3: Partner-specific keg packaging items ─────────────────────────────
insert into public.packaging_items (name, type, volume_fl_oz) values
  ('Fortnight 1/2 Keg',  'keg', 1984),
  ('Fortnight 1/4 Keg',  'keg',  992),
  ('Fortnight 1/6 Keg',  'keg',  661),
  ('Local Time 1/2 Keg', 'keg', 1984),
  ('Local Time 1/4 Keg', 'keg',  992),
  ('Local Time 1/6 Keg', 'keg',  661);

-- ─── Step 4: Keg packaging variations ────────────────────────────────────────
with k as (
  select
    (select id from public.packaging_items where name = 'Fortnight 1/2 Keg')  as fk2,
    (select id from public.packaging_items where name = 'Fortnight 1/4 Keg')  as fk4,
    (select id from public.packaging_items where name = 'Fortnight 1/6 Keg')  as fk6,
    (select id from public.packaging_items where name = 'Local Time 1/2 Keg') as lk2,
    (select id from public.packaging_items where name = 'Local Time 1/4 Keg') as lk4,
    (select id from public.packaging_items where name = 'Local Time 1/6 Keg') as lk6,
    (select id from public.contract_brewing_partners where company_name = 'Fortnight Brewing')  as ftnight,
    (select id from public.contract_brewing_partners where company_name = 'Local Time Brewing') as lt,
    1984::numeric as v2, 992::numeric as v4, 661::numeric as v6
)
insert into public.packaging_variations (container_id, format, partner_id, name, total_volume_fl_oz)
select fk2, 'loose', ftnight, 'Fortnight Blank Coast IPA - 1/2 Keg',    v2 from k union all
select fk4, 'loose', ftnight, 'Fortnight Blank Coast IPA - 1/4 Keg',    v4 from k union all
select fk6, 'loose', ftnight, 'Fortnight Blank Coast IPA - 1/6 Keg',    v6 from k union all
select fk2, 'loose', ftnight, 'Fortnight Mash Pit Lager - 1/2 Keg',     v2 from k union all
select fk4, 'loose', ftnight, 'Fortnight Mash Pit Lager - 1/4 Keg',     v4 from k union all
select fk6, 'loose', ftnight, 'Fortnight Mash Pit Lager - 1/6 Keg',     v6 from k union all
select lk2, 'loose', lt,      'Local Time Vienna Lager - 1/2 Keg',       v2 from k union all
select lk4, 'loose', lt,      'Local Time Vienna Lager - 1/4 Keg',       v4 from k union all
select lk6, 'loose', lt,      'Local Time Vienna Lager - 1/6 Keg',       v6 from k;

-- ─── Step 5: Recipe links for keg variations ─────────────────────────────────
insert into public.recipe_packaging_variations (recipe_id, variation_id)
select r.id, pv.id
from (values
  ('Blank Coast IPA',             'Fortnight Brewing',  'Fortnight Blank Coast IPA - 1/2 Keg'),
  ('Blank Coast IPA',             'Fortnight Brewing',  'Fortnight Blank Coast IPA - 1/4 Keg'),
  ('Blank Coast IPA',             'Fortnight Brewing',  'Fortnight Blank Coast IPA - 1/6 Keg'),
  ('Mash Pit International Lager','Fortnight Brewing',  'Fortnight Mash Pit Lager - 1/2 Keg'),
  ('Mash Pit International Lager','Fortnight Brewing',  'Fortnight Mash Pit Lager - 1/4 Keg'),
  ('Mash Pit International Lager','Fortnight Brewing',  'Fortnight Mash Pit Lager - 1/6 Keg'),
  ('Local Time Vienna Lager',     'Local Time Brewing', 'Local Time Vienna Lager - 1/2 Keg'),
  ('Local Time Vienna Lager',     'Local Time Brewing', 'Local Time Vienna Lager - 1/4 Keg'),
  ('Local Time Vienna Lager',     'Local Time Brewing', 'Local Time Vienna Lager - 1/6 Keg')
) as m(recipe_name, recipe_brewery, variation_name)
join public.recipes r  on r.beer_name = m.recipe_name and r.brewery = m.recipe_brewery
join public.packaging_variations pv on pv.name = m.variation_name
on conflict (recipe_id, variation_id) do nothing;

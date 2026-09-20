-- 1. Recipe expected yields, from what finished batches actually packaged.
--
-- 20 of 25 recipes said 20 bbl per 20 bbl turn — zero loss — so demand forecasts
-- and the scheduler's turn recommendations ran optimistic. Each figure below is
-- the mean packaged bbl per turn over the recipe's finished brewed batches,
-- rounded DOWN to the half barrel. Left out of the mean: batches that converted
-- 10%+ of their fill away (their packaged figure is not the whole batch) and
-- batches that lost over 20% (B-022, B-035 — abnormal, not a forecast). Recipes
-- with no usable batch keep their figure. A variant recipe takes its base's
-- yield: a conversion batch's deposit nets the base's per-bbl rate out of the
-- variant's, and the two rates only cancel when both divide by the same yield.
-- (recipes_resync_ingredient_rates re-derives quantity_per_bbl on this update.)
update public.recipes r
set expected_yield_bbl = v.y
from (values
  ('BBA Imperial Stout (Russell''s Reserve 8-Yr)', 19.0),
  ('Groundhog Imperial Stout',                     19.0),
  ('Spring Bock',                                  19.0),
  ('Winter Porter',                                18.5),
  ('Salted Watermelon Gose',                       18.5),
  ('Black Lager',                                  18.0),
  ('Carolina Pale Ale',                            18.0),
  ('Carolina Vienna Lager',                        18.0),
  ('Mash Pit Lager',                               17.5),
  ('Schönbrunn',                                   17.0),
  ('Pace Yourself Pilsner',                        17.0),
  ('Carolina Mule',                                17.0),
  ('Orange Pilsner',                               17.0),
  ('Transfusion Pilsner',                          17.0),
  ('Blank Coast IPA',                              16.5),
  ('Epic Hazy IPA',                                16.0),
  ('Coffee Epic',                                  16.0)
) as v(name, y)
where btrim(r.beer_name) = v.name;

-- 2. Six fulfilled contract commitments whose booked bbl disagreed with their
-- allocation's percentage x batch volume. Nothing here moves money or changes
-- what is owed: owed = min(percentage x produced, booked), and each row below
-- was checked to give the same owed figure (or, for B-022, a lower one that
-- the credited 15 bbl already covers), so every commitment stays fulfilled.
--
-- Five: the percentage has a deposit or an audit trail behind it, so booked
-- follows the percentage.
with fix as (
  select c.id, b.batch_number, c.volume_bbl as was,
         round(a.percentage * b.volume_bbl / 100, 2) as now
  from public.batch_allocations a
  join public.brew_batches b on b.id = a.batch_id
  join public.commitments  c on c.id = a.contract_request_id
  where a.channel = 'contract_brewing'
    and c.status = 'fulfilled'
    and b.batch_number in ('B-025', 'B-028', 'B-038', 'B-040', 'B-058')
)
update public.commitments c
set volume_bbl = fix.now,
    notes = concat_ws(E'\n', nullif(c.notes, ''),
      '2026-09-20: booked ' || fix.was || ' -> ' || fix.now || ' bbl to match the allocation''s percentage of '
      || fix.batch_number || '. Tidy-up only — owed, credited and deposit unchanged.')
from fix
where c.id = fix.id and c.volume_bbl is distinct from fix.now;

-- One: B-022 was booked and credited at 15 bbl, but its allocation said 75%
-- (30 bbl) against a $0.01 placeholder deposit. Raising booked to 30 would
-- reopen a delivered commitment, so here the percentage follows booked.
update public.batch_allocations a
set percentage = 37.5,
    notes = concat_ws(E'\n', nullif(a.notes, ''),
      '2026-09-20: 75% -> 37.5% to match the 15 bbl booked and credited on B-022. Tidy-up only — no money moved.')
from public.brew_batches b
where b.id = a.batch_id and b.batch_number = 'B-022'
  and a.channel = 'contract_brewing' and a.percentage = 75;

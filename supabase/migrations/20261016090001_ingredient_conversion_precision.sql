-- Give a unit conversion room to be exact.
--
-- 20261016090000 added convert_ingredient_unit() on the promise that a
-- conversion restates numbers without moving value: quantity scales by the
-- ratio, unit cost by its inverse, so quantity x cost is unchanged. At the
-- column scales prod actually carried, that promise was false.
--
-- Flaked Wheat, converted lbs -> oz against prod (in a rolled-back probe):
--   365.000 lbs @ $0.7155  = $261.1575
--   5840.000 oz  @ $0.0447 = $261.0480     <- $0.11 evaporated
--
-- cost_per_unit_usd was numeric(10,4). 0.7155 / 16 is 0.04471875, which does
-- not fit in four decimal places, so the division silently rounded and the
-- extended value fell. stock_quantity was numeric(10,3) with the same problem
-- in the other direction: 5 oz -> lbs is 0.3125, stored as 0.313, and reads
-- back as 5.008 oz.
--
-- This is the same failure the recipe bill hit in
-- 20261006090000_recipe_ingredient_quantity_per_turn.sql, where a
-- numeric(10,4) rate turned 165 lb / 19.5 bbl back into 164.99925 — and it
-- takes the same fix. numeric(18,10) is not decoration: dividing a 3-decimal
-- quantity by 16 needs 3 + 4 = 7 decimal places to stay exact, and every
-- further conversion needs four more.
--
-- Scope is still ingredients only. packaging_items.unit_cost_usd and the
-- produced-inventory columns keep their scales; nothing converts them.

alter table public.ingredients
  alter column cost_per_unit_usd type numeric(18,10);

alter table public.ingredients
  alter column stock_quantity type numeric(18,10);

comment on column public.ingredients.cost_per_unit_usd is
  'Landed cost per unit. numeric(18,10) so convert_ingredient_unit() can divide by a ratio without rounding value away.';
comment on column public.ingredients.stock_quantity is
  'On hand, in `unit`. numeric(18,10) so a unit conversion round-trips exactly.';

-- Verify (rolls back):
--   do $$ declare r jsonb; begin
--     r := convert_ingredient_unit(
--            (select id from ingredients where unit='lbs' and cost_per_unit_usd is not null limit 1), 'oz');
--     raise exception 'PROBE %', r;
--   end $$;

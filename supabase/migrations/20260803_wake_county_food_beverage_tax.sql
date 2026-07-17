-- Wake County — Prepared Food & Beverage Tax (tax party #3)
--
-- Adds the wake_county authority and the 1% prepared-food-&-beverage rate to
-- the canonical registries so the new party template (lib/tax/parties/
-- wakeCountyFoodBeverage) resolves its authority + rate. Pure data seed, no
-- DDL: tax_rates.category has NO check constraint, so the new 'prepared_food'
-- category needs no constraint change. Idempotent via `on conflict do nothing`.
--
-- Human-gated (do not auto-apply).

insert into public.tax_authorities (key, label, display_order)
values ('wake_county', 'Wake County Department of Tax Administration', 4)
on conflict (key) do nothing;

insert into public.tax_rates (key, name, category, party_key, basis, rate, is_active)
values (
  'wake_county_food_beverage_tax',
  'Wake County Prepared Food & Beverage Tax',
  'prepared_food',
  'wake_county',
  'percent',
  0.01,
  true
)
on conflict (key) do nothing;

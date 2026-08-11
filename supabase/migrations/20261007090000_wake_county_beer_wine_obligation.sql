-- Wake County — Beer & Wine License Renewal: seed the filing obligation
--
-- Adding a filing obligation is an INSERT now (see
-- 20261003090001_tax_obligations_lookup.sql, which replaced the three CHECK
-- constraints with this lookup + FKs). Nothing else is needed in the database:
--
--   * The fees are four flat annual dollar amounts per license type, not rates
--     on a base, so they are NOT tax_rates rows — `tax_rates.basis` is
--     per_bbl / per_gallon / percent and none of those describes a $25 license.
--     They live as statutory constants in
--     lib/tax/parties/wakeCountyBeerWine/rates.ts.
--   * Which licenses this brewery holds is per-schedule config
--     (`tax_schedules.config.license_types`), which is jsonb — no DDL.
--   * The Wake County account number, the NC ABC on-premise permit and the
--     FEIN are existing `tax_registrations` rows, resolved by
--     (authority_key, registration_kind) and shared with the Prepared Food &
--     Beverage module rather than duplicated.
--
-- `label` is copied verbatim from TaxPartyTemplate.label for SQL readability;
-- the UI renders the template's label, and lib/tax/obligations.test.ts guards
-- the two against drift.

insert into public.tax_obligations (key, authority_key, label, display_order) values
  ('wake_county_beer_wine', 'wake_county', 'Wake County — Beer & Wine License Renewal', 3)
on conflict (key) do nothing;

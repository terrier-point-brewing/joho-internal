-- Disambiguate `party_key`: a filing obligation is not a tax authority
--
-- `party_key` named two unrelated key spaces in the tax module:
--
--   tax_rates.party_key  → a TAX AUTHORITY key, with a real FK to
--                          tax_authorities.key ('nc_dor', 'federal_ttb',
--                          'wake_county'). Correct. Left exactly as it is.
--
--   tax_schedules.party_key
--   tax_tasks.party_key
--   tax_filing_profiles.party_key
--                        → a FILING OBLIGATION key ('nc_dor_sales_use',
--                          'nc_dor_beer_excise', 'wake_county_food_beverage').
--                          No FK, and 100% orphaned against
--                          tax_authorities.key — which is right, because these
--                          were never authority keys. But the shared column
--                          name reads as though they were, so anyone looking
--                          at tax_tasks.party_key reasonably infers the same
--                          FK that tax_rates.party_key actually has.
--
-- Renaming the second group to `filing_key` so the two key spaces stop looking
-- like one. No data changes: same values, new column name.
--
-- The CHECK constraints pin the three obligation keys that exist today, which
-- makes the column self-documenting and catches typos that would otherwise
-- write a row no party template can resolve. They mirror the registry keys in
-- lib/tax/parties/ — a new filing obligation needs adding in both places.
--
-- Deliberately NOT done here: no `tax_obligations` lookup table and no FK to
-- one. That is a separate modeling decision.

-- ── rename ────────────────────────────────────────────────────────────────────
-- Guarded so a re-run is a no-op. `tax_filing_profiles.party_key` is that
-- table's primary key; the PK constraint follows the column automatically.

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'tax_schedules' and column_name = 'party_key'
  ) then
    alter table public.tax_schedules rename column party_key to filing_key;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'tax_tasks' and column_name = 'party_key'
  ) then
    alter table public.tax_tasks rename column party_key to filing_key;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'tax_filing_profiles' and column_name = 'party_key'
  ) then
    alter table public.tax_filing_profiles rename column party_key to filing_key;
  end if;
end $$;

-- ── enumerate the known filing obligations ────────────────────────────────────

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'tax_schedules_filing_key_check'
  ) then
    alter table public.tax_schedules
      add constraint tax_schedules_filing_key_check
      check (filing_key in ('nc_dor_sales_use', 'nc_dor_beer_excise', 'wake_county_food_beverage'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'tax_tasks_filing_key_check'
  ) then
    alter table public.tax_tasks
      add constraint tax_tasks_filing_key_check
      check (filing_key in ('nc_dor_sales_use', 'nc_dor_beer_excise', 'wake_county_food_beverage'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'tax_filing_profiles_filing_key_check'
  ) then
    alter table public.tax_filing_profiles
      add constraint tax_filing_profiles_filing_key_check
      check (filing_key in ('nc_dor_sales_use', 'nc_dor_beer_excise', 'wake_county_food_beverage'));
  end if;
end $$;

-- ── column comments ───────────────────────────────────────────────────────────

comment on column public.tax_schedules.filing_key is
  'filing obligation this schedule files (registry key in lib/tax/parties/, e.g. nc_dor_sales_use) — NOT a tax_authorities.key';
comment on column public.tax_tasks.filing_key is
  'filing obligation this task files, denormalised from tax_schedules.filing_key — NOT a tax_authorities.key';
comment on column public.tax_filing_profiles.filing_key is
  'filing obligation these prefill values belong to — NOT a tax_authorities.key';

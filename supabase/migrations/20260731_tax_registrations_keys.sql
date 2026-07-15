-- Tax Registrations: stable machine keys
--
-- Adds a nullable `key` column to tax_registrations so specific rows can be
-- found deterministically (by (authority_key, key)) instead of "whichever
-- row happens to be first for this authority" — which the worksheet header
-- (TaxWorksheetShell.tsx) was doing via an ad hoc hardcoded map. Existing
-- freeform rows keep key = null indefinitely; only rows a party template
-- explicitly requires (see lib/tax/registrations.ts's RequiredRegistration)
-- get one.
--
-- Backfill steps are guarded to fire ONLY when exactly one unkeyed row
-- matches the authority — mirrors the cautious pattern in migration
-- 20260728_tax_rates_and_registrations.sql's backfill steps. If the
-- assumption doesn't hold (0 or 2+ matching rows), the step is a no-op and
-- the row(s) are left for manual keying via the new "Required for active
-- filings" settings UI.
--
-- Human-gated (do not auto-apply).

alter table public.tax_registrations add column if not exists key text;

create unique index if not exists tax_registrations_authority_key_key_idx
  on public.tax_registrations (authority_key, key)
  where key is not null;

comment on column public.tax_registrations.key is 'stable machine key for a specific required registration (e.g. nc_dor_account_id, fein, abc_permit_number) — null for freeform/"Other" registrations';

-- Existing NC DOR account/license # row -> shared by every party filed with
-- NC DOR (both nc_dor_sales_use and nc_dor_beer_excise depend on this same
-- row going forward, hence the neutral "nc_dor_account_id" name, not
-- "sales_use"-specific).
update public.tax_registrations
set key = 'nc_dor_account_id'
where authority_key = 'nc_dor'
  and key is null
  and (select count(*) from public.tax_registrations where authority_key = 'nc_dor' and key is null) = 1;

-- Existing IRS FEIN row -> universal (BASE_REQUIRED_REGISTRATIONS, every party).
update public.tax_registrations
set key = 'fein'
where authority_key = 'irs'
  and key is null
  and (select count(*) from public.tax_registrations where authority_key = 'irs' and key is null) = 1;

-- No backfill for the ABC permit (nc_abc) — no row exists yet. It gets
-- created, already keyed 'abc_permit_number', the first time someone saves
-- it through the new "Required for active filings" settings UI.

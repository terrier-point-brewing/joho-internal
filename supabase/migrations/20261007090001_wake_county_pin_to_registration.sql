-- Promote the Wake County gross receipts PIN from a per-module setting to one
-- shared registration.
--
-- It was a `sensitive` field in the Prepared Food & Beverage party's
-- `settingsSchema`, stored in that module's `tax_filing_profiles.values`. That
-- made it per-FILING, but the PIN is a credential for the county ACCOUNT: the
-- Beer & Wine License Renewal module submits with the same account number and
-- the same PIN, and a second copy would be a second thing to rotate and a
-- second thing to get wrong.
--
-- It now lives where the account number already does — one `tax_registrations`
-- row, authority `wake_county`, kind `wake_county_pin` — declared by both Wake
-- County party templates as a `sensitive` RequiredRegistration. Sensitive is a
-- property of the KIND (declared in code), so no column is added here: the API
-- masks the number to "present"/"absent" on the normal GET and returns the real
-- digits only from the admin-only /api/tax/registrations/reveal route.
--
-- This migration moves the stored value and then removes the old key, so the
-- PIN is never in two places.

-- 0. Widen the kind enumeration. `tax_registrations.registration_kind` is
-- CHECK-constrained to the kinds party templates declare (see
-- 20261003090005_tax_registration_kind.sql) — that is the guard that keeps a
-- typo'd kind from silently never resolving, so it is extended here rather
-- than loosened.
alter table public.tax_registrations
  drop constraint if exists tax_registrations_registration_kind_check;

alter table public.tax_registrations
  add constraint tax_registrations_registration_kind_check
  check (
    registration_kind is null
    or registration_kind in (
      'fein',
      'abc_permit_number',
      'abc_permit_number_onpremise',
      'nc_dor_account_id',
      'wake_county_account_id',
      'wake_county_pin'
    )
  );

-- 1. Copy the stored PIN into a registration row (only if one isn't there yet).
insert into public.tax_registrations (authority_key, label, number, display_order, registration_kind)
select
  'wake_county',
  'Wake County Gross Receipts PIN',
  nullif(p.values->>'filing_pin', ''),
  1,
  'wake_county_pin'
from public.tax_filing_profiles p
where p.filing_key = 'wake_county_food_beverage'
  and nullif(p.values->>'filing_pin', '') is not null
  and not exists (
    select 1 from public.tax_registrations r
    where r.authority_key = 'wake_county' and r.registration_kind = 'wake_county_pin'
  );

-- 2. Drop the now-duplicated key from every filing profile that carried it.
update public.tax_filing_profiles
set values = values - 'filing_pin'
where values ? 'filing_pin';

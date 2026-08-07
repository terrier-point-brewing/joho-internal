-- `tax_registrations.key` is not a key — rename it to `registration_kind`
--
-- The table has two text columns that read alike and mean nothing alike:
--
--   authority_key → a real FK to tax_authorities(key). 'nc_dor', 'irs', ...
--   key           → which KIND of registration this row holds. 'fein',
--                   'abc_permit_number', ... No FK, and none possible: these
--                   are declared in code, not stored anywhere.
--
-- A bare column named `key` sitting next to a genuine foreign key is the same
-- confusion #406 just fixed for `party_key`. Renaming it to `registration_kind`
-- so the two stop looking like one key space.
--
-- ── on the NULL row ──────────────────────────────────────────────────────────
-- One of the six rows has a NULL key: the federal_ttb "Account / License #",
-- which does hold a real permit number. It is NOT a data gap and must not be
-- backfilled. NULL is the designed representation of a freeform "Other" row —
-- see app/settings/tax/profile/RegistrationsSection.tsx, which sets
-- `key: null` explicitly with the comment "freeform 'Other' rows are never
-- keyed, unlike the required ones". Rows get a kind only when a party template
-- declares a RequiredRegistration for them, and no template declares a
-- federal_ttb registration today.
--
-- So the CHECK allows NULL explicitly, and new freeform rows keep working. If
-- a template ever declares the TTB permit, that row gets a kind then — from
-- the settings UI, not from a migration.
--
-- ── on the CHECK ─────────────────────────────────────────────────────────────
-- Yes, this is the same kind of enumeration the companion migration
-- (20261003090000_tax_obligations_lookup.sql) just removed for filing_key. The
-- difference is that filing obligations are a growing set the user is actively
-- adding to, while registration kinds are declared inline in party templates
-- as RequiredRegistration.registrationKey and have no independent existence to
-- model. A lookup table here would be a table of strings that only code
-- writes. The CHECK is here to catch typos, and widening it is a one-line
-- migration on one table rather than three.

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'tax_registrations' and column_name = 'key'
  ) then
    alter table public.tax_registrations rename column key to registration_kind;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'tax_registrations_registration_kind_check'
  ) then
    alter table public.tax_registrations
      add constraint tax_registrations_registration_kind_check
      check (
        registration_kind is null
        or registration_kind in (
          'fein',
          'abc_permit_number',
          'abc_permit_number_onpremise',
          'nc_dor_account_id',
          'wake_county_account_id'
        )
      );
  end if;
end $$;

comment on column public.tax_registrations.registration_kind is
  'Which kind of registration this row holds (fein, abc_permit_number, ...), matching RequiredRegistration.registrationKey in lib/tax/parties/. NULL means a freeform "Other" row the operator added by hand — no template requires it. NOT a foreign key; authority_key is the FK on this table.';

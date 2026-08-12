-- TTB — Pilot Brewer Excise Tax Return (TTB F 5130.Pilot-B): seed the filing
-- obligation and give the federal_ttb registration its kind.
--
-- Adding a filing obligation is an INSERT (see
-- 20261003090001_tax_obligations_lookup.sql, which replaced the three CHECK
-- constraints with this lookup + FKs). Two things and no more are needed here:
--
--   * The obligation row itself. `label` is copied verbatim from
--     TaxPartyTemplate.label for SQL readability; the UI renders the template's
--     label, and lib/tax/obligations.test.ts guards the two against drift.
--   * The federal_ttb registration's `registration_kind`. See below.
--
-- Deliberately NOT here:
--
--   * The rate. `tax_rates` already carries key `federal_beer_excise`
--     ($3.50, basis `per_bbl`, party_key `federal_ttb`) from
--     20260728_tax_rates_and_registrations.sql. Unlike Wake County's flat
--     license fees, this IS a rate on a base and the existing `per_bbl` basis
--     describes it exactly, so it stays in the registry rather than becoming a
--     code constant. The $16.00 and $18.00 tiers (form lines 9 and 10) are
--     statutory, never configurable, and unreachable at this brewery's volume;
--     they live as constants in lib/tax/parties/ttbBeerExcise/rates.ts.
--   * The filing schedule. Which periods are filed is operator data created
--     through Finance > Tax > Schedules, not a migration.
--   * Any worksheet storage. The whole return lives in `tax_tasks.worksheet`
--     (jsonb), same as every other party.

insert into public.tax_obligations (key, authority_key, label, display_order) values
  ('ttb_beer_excise', 'federal_ttb', 'TTB — Pilot Brewer Excise Tax Return (5130.Pilot-B)', 4)
on conflict (key) do nothing;

-- The federal_ttb registration row has carried a NULL `registration_kind`
-- since 20261003090005_tax_registration_kind.sql, which called this out
-- explicitly: the row was left unkeyed because no party template required it,
-- and its header says the row "gets a kind then — from the template that
-- declares it", not from a speculative backfill.
--
-- lib/tax/parties/ttbBeerExcise/template.ts is that template. It declares
-- (federal_ttb, ttb_brewers_notice), so the row is now a required registration
-- with a resolvable kind rather than a freeform operator row, and the label is
-- corrected to what the form actually asks for (line 4, "Brewer's Notice
-- Number") instead of the generic "Account / License #" the restructure seeded.
--
-- `tax_registrations.registration_kind` is gated by an enumerated CHECK, and
-- the gate is right: a kind that no `RequiredRegistration` declares is a typo,
-- not a new fact, and nothing would ever resolve it. So the constraint is
-- TAUGHT the new kind rather than loosened — the enumeration stays closed, it
-- just knows one more member. (Contrast 20260xxx's `external_account_code`
-- lesson: an enumerated CHECK on a value a VENDOR supplies is wrong, because
-- their vocabulary isn't ours to bound. This value is ours: it must match a
-- registrationKey declared in lib/tax/parties/, and that set is finite and
-- known at deploy time.)
alter table public.tax_registrations
  drop constraint tax_registrations_registration_kind_check;

alter table public.tax_registrations
  add constraint tax_registrations_registration_kind_check
  check (
    registration_kind is null
    or registration_kind = any (array[
      'fein',
      'abc_permit_number',
      'abc_permit_number_onpremise',
      'nc_dor_account_id',
      'wake_county_account_id',
      'wake_county_pin',
      'ttb_brewers_notice'
    ])
  );

-- Scoped by `registration_kind is null` so this can only ever touch the
-- unclaimed row: if an operator has since added their own freeform federal_ttb
-- rows, this would hit them too, hence the additional label guard.
update public.tax_registrations
set registration_kind = 'ttb_brewers_notice',
    label = 'TTB Brewer''s Notice Number'
where authority_key = 'federal_ttb'
  and registration_kind is null
  and label = 'Account / License #';

-- Beer Excise Header Fields
--
-- Adds the filer-identity fields the worksheet header (every NC DOR filing,
-- not just beer excise) needs but tax_entity_profile didn't yet carry:
-- trade name (DBA), fax number, and state of domicile. These supersede the
-- same-named fields that lived on the nc_dor_beer_excise party's own
-- settingsSchema (lib/tax/parties/ncDorBeerExcise/template.ts) — moved here
-- since filer identity is shared across every party, not beer-excise-only.
-- No backfill needed: no tax_filing_profiles row exists yet for
-- nc_dor_beer_excise (confirmed empty prior to this migration), so there is
-- nothing to carry over from the old party-level fields.
--
-- Column-add steps use IF NOT EXISTS and are safe to re-run.
-- Human-gated (do not auto-apply).

alter table public.tax_entity_profile add column if not exists trade_name text;
alter table public.tax_entity_profile add column if not exists fax_number text;
alter table public.tax_entity_profile add column if not exists state_of_domicile text;

comment on column public.tax_entity_profile.trade_name is 'DBA / trade name, shown on filing worksheet headers (e.g. Form B-C-710)';
comment on column public.tax_entity_profile.fax_number is 'filer fax number, shown on filing worksheet headers';
comment on column public.tax_entity_profile.state_of_domicile is 'state the filer is domiciled in (2-letter code), shown on filing worksheet headers';

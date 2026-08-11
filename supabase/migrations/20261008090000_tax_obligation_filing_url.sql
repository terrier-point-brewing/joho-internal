-- Where each filing obligation actually gets filed
--
-- A schedule says how often a return is filed and when it is due. An
-- obligation says what the return IS. "Which portal do I submit it on" is a
-- fact about the return, not about the cadence: NC DOR's e-file portal is the
-- same URL whether the sales & use schedule is monthly or quarterly, and it
-- would be duplicated (and could disagree with itself) if it were stored per
-- schedule row.
--
-- So it lives on `tax_obligations`, beside `authority_key` and `label`, and is
-- edited under Settings → Tax Filing — the per-module setup pane — while
-- Finance → Tax renders it as a link on the schedule and task rows, where the
-- filer is when they need it.
--
-- Nullable: an existing obligation has no URL yet, and a paper filing has none
-- at all. The CHECK constrains scheme only. Enumerating hosts here would
-- repeat the mistake #406's `filing_key` CHECK made — portals get rehosted,
-- and a migration should not be the price of a vendor's URL change.

alter table public.tax_obligations
  add column if not exists filing_url text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tax_obligations_filing_url_scheme_check') then
    alter table public.tax_obligations
      add constraint tax_obligations_filing_url_scheme_check
      check (filing_url is null or filing_url ~ '^https?://[^[:space:]]+$');
  end if;
end $$;

comment on column public.tax_obligations.filing_url is
  'Link to the authority portal where this obligation is actually filed. Nullable (paper filings have none); http(s) only. Edited under Settings -> Tax Filing, rendered as a link in Finance -> Tax.';

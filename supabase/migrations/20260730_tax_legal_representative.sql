-- Tax Profile: Legal Representative
--
-- Splits "the person who signs for the business" out of tax_entity_profile
-- (which stays business-identity-only: legal name, trade name, address,
-- general phone/fax) into its own singleton table, same pattern as
-- tax_entity_profile itself (id boolean primary key default true).
--
-- "State of Domicile" is deliberately NOT a column here or anywhere — it's
-- this row's `state`, read directly wherever it needs to be displayed (see
-- app/finance/tax/[taskId]/TaxWorksheetShell.tsx's IdentityHeader). The
-- `state_of_domicile` column tax_entity_profile gained in migration
-- 20260729_beer_excise_header_fields.sql is dropped below — it never had
-- real data (no worksheet consumed it yet), so no backfill is needed for it.
--
-- Human-gated (do not auto-apply).

-- ── 1. tax_legal_representative (singleton) ───────────────────────────────────

create table if not exists public.tax_legal_representative (
  id            boolean     primary key default true check (id),
  name          text,
  title         text,
  phone         text,
  email         text,
  ssn           text,
  address_line1 text,
  address_line2 text,
  city          text,
  state         text,
  postal_code   text,
  updated_at    timestamptz not null default now()
);

alter table public.tax_legal_representative enable row level security;
create policy "finance readers" on public.tax_legal_representative
  for all to authenticated
  using ( public.get_my_role() = any (public.finance_reader_roles()) )
  with check ( public.get_my_role() = any (public.finance_reader_roles()) );

comment on column public.tax_legal_representative.id is 'singleton guard: boolean PK fixed true so only one row can exist';
comment on column public.tax_legal_representative.ssn is 'treated as sensitive in the app layer, same convention as the legacy tax_entity_profile.ssn';
comment on table public.tax_legal_representative is 'the individual who signs/certifies filings on behalf of the business — distinct from tax_entity_profile (the business itself)';

-- ── 2. Backfill from the existing tax_entity_profile row ──────────────────────
-- Safe no-op when no tax_entity_profile row exists yet; never clobbers a
-- pre-existing tax_legal_representative row (on conflict do nothing).

insert into public.tax_legal_representative (id, name, email, ssn)
select true, e.contact_name, e.contact_email, e.ssn
from public.tax_entity_profile e
where e.id = true
on conflict (id) do nothing;

-- ── 3. Drop the columns that moved off tax_entity_profile ─────────────────────

alter table public.tax_entity_profile drop column if exists ssn;
alter table public.tax_entity_profile drop column if exists contact_name;
alter table public.tax_entity_profile drop column if exists contact_email;
alter table public.tax_entity_profile drop column if exists state_of_domicile;

comment on column public.tax_entity_profile.contact_phone is 'business-level phone number (not tied to a specific person — see tax_legal_representative.phone for the signer''s own number)';

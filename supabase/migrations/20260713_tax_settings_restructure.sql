-- Tax Settings Restructure: authorities spine + entity profile + excise party_key
--
-- Splits tax config into an entity-level identity (tax_entity_profile, singleton)
-- and per-receiving-party filing/excise config keyed off a new receiving-party
-- spine (tax_authorities). Adds excise_tax_rates.party_key (FK) superseding the
-- free-text receiving_party, and migrates filer identity out of
-- tax_filing_profiles so those rows hold only party-operational settings.
-- Table/column/backfill steps are idempotent; the create-policy statements
-- follow the house run-once pattern (no CREATE POLICY IF NOT EXISTS in
-- Postgres). Human-gated (do not auto-apply).

-- ── (a) tax_authorities (receiving-party spine) + seed ────────────────────────

create table if not exists public.tax_authorities (
  key                 text        primary key,
  label               text        not null,
  kind                text        not null check (kind in ('filing', 'excise', 'both')),
  registration_number text,
  display_order       int         not null default 0,
  updated_at          timestamptz not null default now()
);

insert into public.tax_authorities (key, label, kind, display_order)
values
  ('nc_dor',       'NC Department of Revenue',                    'both',   0),
  ('federal_ttb',  'Alcohol and Tobacco Tax and Trade Bureau',    'excise', 1)
on conflict (key) do nothing;

-- ── (b) tax_entity_profile (singleton — filer identity) ───────────────────────

create table if not exists public.tax_entity_profile (
  id            boolean     primary key default true check (id),
  legal_name    text,
  fein          text,
  ssn           text,
  contact_name  text,
  contact_email text,
  contact_phone text,
  address_line1 text,
  address_line2 text,
  city          text,
  state         text,
  postal_code   text,
  updated_at    timestamptz not null default now()
);

-- ── (c) excise_tax_rates.party_key FK ─────────────────────────────────────────

alter table public.excise_tax_rates
  add column if not exists party_key text references public.tax_authorities(key);

-- ── (d) backfill excise_tax_rates.party_key from legacy receiving_party ────────
-- Unmatched rows are left null (manual cleanup later).

update public.excise_tax_rates
set party_key = 'nc_dor'
where party_key is null
  and ( receiving_party ilike '%NC%'
     or receiving_party ilike '%North Carolina%'
     or receiving_party ilike '%DOR%' );

update public.excise_tax_rates
set party_key = 'federal_ttb'
where party_key is null
  and ( receiving_party ilike '%TTB%'
     or receiving_party ilike '%federal%'
     or receiving_party ilike '%alcohol and tobacco%' );

-- ── (e) backfill identity out of tax_filing_profiles ──────────────────────────
-- Safe no-op when the nc_dor_sales_use row is absent; never clobbers a
-- pre-existing tax_entity_profile row (on conflict do nothing).

-- (e.1) seed the singleton entity profile from the legacy profile values
insert into public.tax_entity_profile
  (id, fein, ssn, contact_name, contact_email, contact_phone)
select
  true,
  v.values->>'fein',
  v.values->>'ssn',
  v.values->>'contact_name',
  v.values->>'contact_email',
  v.values->>'contact_phone'
from public.tax_filing_profiles v
where v.party_key = 'nc_dor_sales_use'
on conflict (id) do nothing;

-- (e.2) carry the legacy account_id into the authority registration number
update public.tax_authorities a
set registration_number = v.values->>'account_id',
    updated_at = now()
from public.tax_filing_profiles v
where a.key = 'nc_dor'
  and a.registration_number is null
  and v.party_key = 'nc_dor_sales_use'
  and v.values->>'account_id' is not null;

-- (e.3) strip migrated keys from the profile jsonb (leaves general_sales_tax_id)
update public.tax_filing_profiles
set values = values - 'fein' - 'ssn' - 'contact_name' - 'contact_email' - 'contact_phone' - 'account_id',
    updated_at = now()
where party_key = 'nc_dor_sales_use';

-- ── (f) RLS (service-role-only) + comments ────────────────────────────────────

alter table public.tax_authorities enable row level security;
create policy "finance readers" on public.tax_authorities
  for all to authenticated
  using ( public.get_my_role() = any (public.finance_reader_roles()) )
  with check ( public.get_my_role() = any (public.finance_reader_roles()) );

alter table public.tax_entity_profile enable row level security;
create policy "finance readers" on public.tax_entity_profile
  for all to authenticated
  using ( public.get_my_role() = any (public.finance_reader_roles()) )
  with check ( public.get_my_role() = any (public.finance_reader_roles()) );

comment on column public.tax_authorities.kind is 'whether this authority is a filing authority, an excise authority, or both';
comment on column public.tax_authorities.registration_number is 'account/license/permit number the filer holds with this authority';
comment on column public.tax_authorities.display_order is 'ascending sort order for settings UI';
comment on column public.tax_entity_profile.id is 'singleton guard: boolean PK fixed true so only one row can exist';
comment on column public.tax_entity_profile.fein is 'federal employer identification number; plain column, not sensitive at the DB level';
comment on column public.tax_entity_profile.ssn is 'sole-proprietor SSN; treated as sensitive in the app layer';
comment on column public.excise_tax_rates.party_key is 'receiving authority (FK tax_authorities.key); supersedes free-text receiving_party';

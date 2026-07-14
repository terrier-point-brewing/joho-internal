-- Tax Rates + Registrations Rework
--
-- Part 1 (Tax Profile): adds tax_registrations at a lower grain than
-- tax_authorities (authority -> N registrations), moves Federal EIN in as a
-- registration under 'irs', seeds the 'irs'/'nc_abc' authorities, then drops
-- tax_authorities.kind / .registration_number and tax_entity_profile.fein
-- once backfilled.
--
-- Part 3 (canonical rate registry): evolves excise_tax_rates -> tax_rates
-- IN PLACE (rename, never drop+recreate) so the historical
-- export_transaction_taxes.excise_tax_rate_id FK stays valid against the same
-- row ids. Seeds excise (corrected NC rate 0.6171, was stale 0.62), NC DOR
-- Sales & Use state/line rates, and all 100 NC counties' local/transit tiers
-- (generated from lib/tax/parties/ncDorSalesUse/rates.ts via a throwaway
-- scratchpad script — not hand-typed).
--
-- Table/column steps use IF (NOT) EXISTS guards and are safe to re-run;
-- `rename column` has no such guard, so those statements are one-shot, not
-- re-runnable. The create-policy statement follows the house run-once
-- pattern (no CREATE POLICY IF NOT EXISTS in Postgres). Ordering is
-- deliberate: tax_authorities.kind is dropped early (step 6, before it's
-- seeded further) since no later step reads it; backfill (step 7) reads
-- tax_authorities.registration_number and tax_entity_profile.fein, which are
-- only dropped afterward (step 8).
--
-- Human-gated (do not auto-apply).

-- ── 1. excise_tax_rates -> tax_rates (evolve in place, preserve id/FK) ────────

alter table if exists public.excise_tax_rates rename to tax_rates;

alter table public.tax_rates rename column unit to basis;
alter table public.tax_rates drop constraint if exists excise_tax_rates_unit_check;
alter table public.tax_rates drop constraint if exists tax_rates_basis_check;
update public.tax_rates set basis = 'per_bbl' where basis = 'bbl';
update public.tax_rates set basis = 'per_gallon' where basis = 'gallon';
alter table public.tax_rates
  add constraint tax_rates_basis_check check (basis in ('per_bbl', 'per_gallon', 'percent'));

alter table public.tax_rates rename column rate_usd to rate;

alter table public.tax_rates add column if not exists key text;
alter table public.tax_rates add column if not exists category text;

alter table public.tax_rates drop column if exists receiving_party;
alter table public.tax_rates drop column if exists square_catalog_item_id;
alter table public.tax_rates drop column if exists square_catalog_variation_id;

-- ── 2. Backfill the 2 existing excise rows + lock down key/category ──────────
-- Matched by the legacy seed `name` (not a blanket basis/key-is-null match) so
-- this can't collapse/duplicate-key if extra excise_tax_rates rows exist. If
-- any additional excise rows exist, they must be given a `key` manually here
-- or the `key set not null` below will (intentionally, loudly) fail rather
-- than silently collapse.

update public.tax_rates
set key = 'federal_beer_excise',
    category = 'excise',
    party_key = 'federal_ttb',
    name = 'Federal Beer Excise Tax',
    basis = 'per_bbl',
    rate = 3.50
where name = 'Federal Excise Tax';

update public.tax_rates
set key = 'nc_dor_beer_excise',
    category = 'excise',
    party_key = 'nc_dor',
    name = 'NC Beer Excise Tax',
    basis = 'per_gallon',
    rate = 0.6171 -- corrected; legacy seed had the stale 0.62
where name = 'NC Excise Tax';

alter table public.tax_rates alter column key set not null;
alter table public.tax_rates drop constraint if exists tax_rates_key_unique;
alter table public.tax_rates add constraint tax_rates_key_unique unique (key);
alter table public.tax_rates alter column category set not null;

-- ── 3. Seed NC DOR Sales & Use state + form-line rates ────────────────────────
-- category='sales', party_key='nc_dor', basis='percent'.
-- Values mirror lib/tax/parties/ncDorSalesUse/rates.ts NC_STATE_RATE / RATE_BY_LINE.

insert into public.tax_rates (key, name, category, party_key, basis, rate) values
  ('nc_sales_state',    'NC State Sales & Use Tax',              'sales', 'nc_dor', 'percent', 0.0475),
  ('nc_sales_line_4',   'NC Sales & Use — Line 4 (General State Rate)',    'sales', 'nc_dor', 'percent', 0.0475),
  ('nc_sales_line_5',   'NC Sales & Use — Line 5 (3% State Rate)',         'sales', 'nc_dor', 'percent', 0.03),
  ('nc_sales_line_6',   'NC Sales & Use — Line 6 (Modular Homes)',         'sales', 'nc_dor', 'percent', 0.0475),
  ('nc_sales_line_7',   'NC Sales & Use — Line 7 (Manufactured Homes)',    'sales', 'nc_dor', 'percent', 0.0475),
  ('nc_sales_line_8',   'NC Sales & Use — Line 8 (2% Food Rate)',          'sales', 'nc_dor', 'percent', 0.02),
  ('nc_sales_line_9',   'NC Sales & Use — Line 9 (2% County Rate)',        'sales', 'nc_dor', 'percent', 0.02),
  ('nc_sales_line_10',  'NC Sales & Use — Line 10 (2.25% County Rate)',    'sales', 'nc_dor', 'percent', 0.0225),
  ('nc_sales_line_11',  'NC Sales & Use — Line 11 (0.5% Transit County Rate)',  'sales', 'nc_dor', 'percent', 0.005),
  ('nc_sales_line_12',  'NC Sales & Use — Line 12 (0.25% Transit County Rate)', 'sales', 'nc_dor', 'percent', 0.0025)
on conflict (key) do nothing;

-- ── 4. Seed NC county local/transit tiers (100 counties, generated) ──────────
-- category='local'/'transit', party_key='nc_dor', basis='percent'.
-- Generated from lib/tax/parties/ncDorSalesUse/rates.ts (NC_COUNTIES +
-- NC_COUNTY_TIERS tier-precedence resolution) via a throwaway scratchpad
-- script — not hand-typed. 100 'local' rows + 4 'transit' rows (Durham,
-- Mecklenburg, Orange, Wake — the only counties with transit tax).

insert into public.tax_rates (key, name, category, party_key, basis, rate) values
  ('nc_local_ALAMANCE', 'NC Local Sales Tax — Alamance County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_ALEXANDER', 'NC Local Sales Tax — Alexander County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_local_ALLEGHANY', 'NC Local Sales Tax — Alleghany County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_local_ANSON', 'NC Local Sales Tax — Anson County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_local_ASHE', 'NC Local Sales Tax — Ashe County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_local_AVERY', 'NC Local Sales Tax — Avery County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_BEAUFORT', 'NC Local Sales Tax — Beaufort County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_BERTIE', 'NC Local Sales Tax — Bertie County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_local_BLADEN', 'NC Local Sales Tax — Bladen County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_BRUNSWICK', 'NC Local Sales Tax — Brunswick County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_BUNCOMBE', 'NC Local Sales Tax — Buncombe County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_local_BURKE', 'NC Local Sales Tax — Burke County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_CABARRUS', 'NC Local Sales Tax — Cabarrus County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_local_CALDWELL', 'NC Local Sales Tax — Caldwell County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_CAMDEN', 'NC Local Sales Tax — Camden County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_CARTERET', 'NC Local Sales Tax — Carteret County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_CASWELL', 'NC Local Sales Tax — Caswell County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_CATAWBA', 'NC Local Sales Tax — Catawba County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_local_CHATHAM', 'NC Local Sales Tax — Chatham County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_local_CHEROKEE', 'NC Local Sales Tax — Cherokee County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_local_CHOWAN', 'NC Local Sales Tax — Chowan County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_CLAY', 'NC Local Sales Tax — Clay County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_local_CLEVELAND', 'NC Local Sales Tax — Cleveland County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_COLUMBUS', 'NC Local Sales Tax — Columbus County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_CRAVEN', 'NC Local Sales Tax — Craven County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_CUMBERLAND', 'NC Local Sales Tax — Cumberland County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_local_CURRITUCK', 'NC Local Sales Tax — Currituck County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_DARE', 'NC Local Sales Tax — Dare County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_DAVIDSON', 'NC Local Sales Tax — Davidson County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_local_DAVIE', 'NC Local Sales Tax — Davie County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_DUPLIN', 'NC Local Sales Tax — Duplin County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_local_DURHAM', 'NC Local Sales Tax — Durham County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_transit_DURHAM', 'NC Transit Sales Tax — Durham County', 'transit', 'nc_dor', 'percent', 0.005),
  ('nc_local_EDGECOMBE', 'NC Local Sales Tax — Edgecombe County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_local_FORSYTH', 'NC Local Sales Tax — Forsyth County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_local_FRANKLIN', 'NC Local Sales Tax — Franklin County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_GASTON', 'NC Local Sales Tax — Gaston County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_local_GATES', 'NC Local Sales Tax — Gates County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_GRAHAM', 'NC Local Sales Tax — Graham County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_local_GRANVILLE', 'NC Local Sales Tax — Granville County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_GREENE', 'NC Local Sales Tax — Greene County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_local_GUILFORD', 'NC Local Sales Tax — Guilford County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_HALIFAX', 'NC Local Sales Tax — Halifax County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_local_HARNETT', 'NC Local Sales Tax — Harnett County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_local_HAYWOOD', 'NC Local Sales Tax — Haywood County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_local_HENDERSON', 'NC Local Sales Tax — Henderson County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_HERTFORD', 'NC Local Sales Tax — Hertford County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_local_HOKE', 'NC Local Sales Tax — Hoke County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_HYDE', 'NC Local Sales Tax — Hyde County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_IREDELL', 'NC Local Sales Tax — Iredell County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_JACKSON', 'NC Local Sales Tax — Jackson County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_local_JOHNSTON', 'NC Local Sales Tax — Johnston County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_JONES', 'NC Local Sales Tax — Jones County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_local_LEE', 'NC Local Sales Tax — Lee County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_local_LENOIR', 'NC Local Sales Tax — Lenoir County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_LINCOLN', 'NC Local Sales Tax — Lincoln County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_local_MACON', 'NC Local Sales Tax — Macon County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_MADISON', 'NC Local Sales Tax — Madison County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_local_MARTIN', 'NC Local Sales Tax — Martin County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_local_MCDOWELL', 'NC Local Sales Tax — McDowell County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_MECKLENBURG', 'NC Local Sales Tax — Mecklenburg County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_transit_MECKLENBURG', 'NC Transit Sales Tax — Mecklenburg County', 'transit', 'nc_dor', 'percent', 0.005),
  ('nc_local_MITCHELL', 'NC Local Sales Tax — Mitchell County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_MONTGOMERY', 'NC Local Sales Tax — Montgomery County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_local_MOORE', 'NC Local Sales Tax — Moore County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_local_NASH', 'NC Local Sales Tax — Nash County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_NEW_HANOVER', 'NC Local Sales Tax — New Hanover County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_local_NORTHAMPTON', 'NC Local Sales Tax — Northampton County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_ONSLOW', 'NC Local Sales Tax — Onslow County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_local_ORANGE', 'NC Local Sales Tax — Orange County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_transit_ORANGE', 'NC Transit Sales Tax — Orange County', 'transit', 'nc_dor', 'percent', 0.005),
  ('nc_local_PAMLICO', 'NC Local Sales Tax — Pamlico County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_PASQUOTANK', 'NC Local Sales Tax — Pasquotank County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_local_PENDER', 'NC Local Sales Tax — Pender County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_PERQUIMANS', 'NC Local Sales Tax — Perquimans County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_PERSON', 'NC Local Sales Tax — Person County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_PITT', 'NC Local Sales Tax — Pitt County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_local_POLK', 'NC Local Sales Tax — Polk County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_RANDOLPH', 'NC Local Sales Tax — Randolph County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_local_RICHMOND', 'NC Local Sales Tax — Richmond County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_ROBESON', 'NC Local Sales Tax — Robeson County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_local_ROCKINGHAM', 'NC Local Sales Tax — Rockingham County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_local_ROWAN', 'NC Local Sales Tax — Rowan County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_local_RUTHERFORD', 'NC Local Sales Tax — Rutherford County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_local_SAMPSON', 'NC Local Sales Tax — Sampson County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_local_SCOTLAND', 'NC Local Sales Tax — Scotland County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_STANLY', 'NC Local Sales Tax — Stanly County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_local_STOKES', 'NC Local Sales Tax — Stokes County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_SURRY', 'NC Local Sales Tax — Surry County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_local_SWAIN', 'NC Local Sales Tax — Swain County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_local_TRANSYLVANIA', 'NC Local Sales Tax — Transylvania County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_TYRRELL', 'NC Local Sales Tax — Tyrrell County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_UNION', 'NC Local Sales Tax — Union County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_VANCE', 'NC Local Sales Tax — Vance County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_WAKE', 'NC Local Sales Tax — Wake County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_transit_WAKE', 'NC Transit Sales Tax — Wake County', 'transit', 'nc_dor', 'percent', 0.005),
  ('nc_local_WARREN', 'NC Local Sales Tax — Warren County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_WASHINGTON', 'NC Local Sales Tax — Washington County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_local_WATAUGA', 'NC Local Sales Tax — Watauga County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_WAYNE', 'NC Local Sales Tax — Wayne County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_WILKES', 'NC Local Sales Tax — Wilkes County', 'local', 'nc_dor', 'percent', 0.0225),
  ('nc_local_WILSON', 'NC Local Sales Tax — Wilson County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_YADKIN', 'NC Local Sales Tax — Yadkin County', 'local', 'nc_dor', 'percent', 0.02),
  ('nc_local_YANCEY', 'NC Local Sales Tax — Yancey County', 'local', 'nc_dor', 'percent', 0.02)
on conflict (key) do nothing;

-- ── 5. tax_registrations (lower-grain than tax_authorities) ──────────────────

create table if not exists public.tax_registrations (
  id             uuid primary key default gen_random_uuid(),
  authority_key  text not null references public.tax_authorities(key) on delete cascade,
  label          text not null,
  number         text,
  display_order  int not null default 0,
  updated_at     timestamptz not null default now()
);

create index if not exists tax_registrations_authority_idx on public.tax_registrations(authority_key);

alter table public.tax_registrations enable row level security;
create policy "finance readers" on public.tax_registrations
  for all to authenticated
  using ( public.get_my_role() = any (public.finance_reader_roles()) )
  with check ( public.get_my_role() = any (public.finance_reader_roles()) );

-- ── 6. Seed additional authorities (irs, nc_abc) ──────────────────────────────
-- 'kind' is dropped here (before the insert), not in step 8 — no later step
-- reads tax_authorities.kind, so the drop can move up and the insert below
-- doesn't need to supply a value for a NOT NULL column with no default.

alter table public.tax_authorities drop column if exists kind;

insert into public.tax_authorities (key, label, display_order)
values
  ('irs',    'Internal Revenue Service',                                     2),
  ('nc_abc', 'North Carolina Alcoholic Beverage Control Commission',         3)
on conflict (key) do nothing;

-- ── 7. Backfill registrations (must run BEFORE the column drops in step 8) ───

insert into public.tax_registrations (authority_key, label, number, display_order)
select a.key, 'Account / License #', a.registration_number, 0
from public.tax_authorities a
where a.registration_number is not null;

insert into public.tax_registrations (authority_key, label, number, display_order)
select 'irs', 'Federal EIN (FEIN)', e.fein, 0
from public.tax_entity_profile e
where e.id = true and e.fein is not null;

-- ── 8. Drop columns superseded by tax_registrations / tax_rates ──────────────

alter table public.tax_authorities drop column if exists registration_number;
alter table public.tax_entity_profile drop column if exists fein;

-- ── 9. Comments ────────────────────────────────────────────────────────────

comment on column public.tax_rates.key is 'stable machine key referenced by lib/tax modules and production excise (e.g. nc_dor_beer_excise, nc_local_WAKE)';
comment on column public.tax_rates.category is 'rate grouping: excise | sales | local | transit';
comment on column public.tax_rates.basis is 'how the rate applies: per_bbl | per_gallon | percent';
comment on column public.tax_rates.rate is 'decimal rate value (dollars per unit for per_bbl/per_gallon, fraction for percent)';
comment on table public.tax_registrations is 'per-authority account/license/permit numbers (lower grain than tax_authorities; an authority may hold N registrations)';
comment on column public.tax_registrations.label is 'user-facing label for this registration (e.g. "Federal EIN (FEIN)", "Account / License #")';
comment on column public.tax_registrations.display_order is 'ascending sort order within an authority group for settings UI';

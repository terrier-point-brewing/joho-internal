-- Promote the filing obligation from a CHECK-constrained string to a real table
--
-- #406 renamed `party_key` -> `filing_key` on tax_schedules, tax_tasks and
-- tax_filing_profiles, and pinned the three known obligations with a CHECK on
-- each. That was the right interim step, but a CHECK does not scale: adding a
-- fourth filing obligation would need a migration on three tables just to
-- widen an enumeration, and the enumeration is duplicated three times.
--
-- Replaces the three CHECKs with one lookup table and three foreign keys.
-- Adding an obligation becomes an INSERT.
--
-- Shape mirrors `tax_authorities` (text `key` PK, `label`, `display_order`,
-- `updated_at`), which is the established idiom for this module's lookups.
--
-- Every obligation belongs to exactly one authority, so `authority_key` is a
-- real FK — the relationship `tax_schedules.party_key` used to *look* like it
-- had and never did.
--
-- ON DELETE RESTRICT throughout, deliberately:
--   * obligation -> authority: deleting NC DOR while it still owns two filing
--     obligations should fail loudly, not orphan or cascade them away.
--   * schedule/task/profile -> obligation: a filed tax task is a financial
--     record. Deleting the obligation out from under it must not silently take
--     the filing history with it. (`tax_registrations.authority_key` uses
--     CASCADE, which is fine there — a registration is a piece of an authority.
--     A filed task is not a piece of an obligation.)
--
-- NOTE ON `label`: the tax UI does NOT read it. Every label the screens render
-- comes from `TaxPartyTemplate.label` in lib/tax/parties/, served by
-- GET /api/tax/parties (see app/finance/tax/ScheduleList.tsx and TaskList.tsx).
-- The column exists so the table is legible in SQL and in the Supabase editor,
-- and the seeded values are copied verbatim from the templates. The template
-- stays authoritative for rendering; a drift guard lives in
-- lib/tax/obligations.test.ts.

-- ── the lookup ────────────────────────────────────────────────────────────────

create table if not exists public.tax_obligations (
  key           text primary key,
  authority_key text        not null references public.tax_authorities(key) on delete restrict,
  label         text        not null,
  display_order integer     not null default 0,
  updated_at    timestamptz not null default now()
);

comment on table public.tax_obligations is
  'Filing obligations (a return this brewery files), e.g. nc_dor_sales_use. One authority owns many obligations. The runtime behaviour of an obligation — periods, worksheet math, due rules — lives in a TaxPartyTemplate in lib/tax/parties/ keyed by this same string; a row here without a template will throw at getParty().';
comment on column public.tax_obligations.key is
  'Registry key, must match a TaxPartyTemplate.key in lib/tax/parties/';
comment on column public.tax_obligations.authority_key is
  'The authority this obligation is filed with';
comment on column public.tax_obligations.label is
  'Human label for SQL/console readability. NOT what the app renders — the UI uses TaxPartyTemplate.label. Keep in sync with the template.';

create index if not exists tax_obligations_authority_key_idx
  on public.tax_obligations (authority_key);

-- Same read gate as every other tax lookup.
alter table public.tax_obligations enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'tax_obligations' and policyname = 'finance readers'
  ) then
    create policy "finance readers" on public.tax_obligations
      for all to authenticated
      using (get_my_role() = any (finance_reader_roles()))
      with check (get_my_role() = any (finance_reader_roles()));
  end if;
end $$;

-- ── seed the three that exist ─────────────────────────────────────────────────
-- Labels copied verbatim from lib/tax/parties/*/template.ts.

insert into public.tax_obligations (key, authority_key, label, display_order) values
  ('nc_dor_sales_use',          'nc_dor',      'NC DOR — Sales & Use Tax',                  0),
  ('nc_dor_beer_excise',        'nc_dor',      'NC DOR — Beer Excise Tax (B-C-710)',        1),
  ('wake_county_food_beverage', 'wake_county', 'Wake County — Prepared Food & Beverage Tax', 2)
on conflict (key) do nothing;

-- ── drop the interim CHECKs, add the real FKs ─────────────────────────────────
-- Order matters: the CHECK must go before the FK, or a future obligation would
-- satisfy the FK and still be rejected by the stale enumeration.

alter table public.tax_schedules        drop constraint if exists tax_schedules_filing_key_check;
alter table public.tax_tasks            drop constraint if exists tax_tasks_filing_key_check;
alter table public.tax_filing_profiles  drop constraint if exists tax_filing_profiles_filing_key_check;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tax_schedules_filing_key_fkey') then
    alter table public.tax_schedules
      add constraint tax_schedules_filing_key_fkey
      foreign key (filing_key) references public.tax_obligations(key) on delete restrict;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'tax_tasks_filing_key_fkey') then
    alter table public.tax_tasks
      add constraint tax_tasks_filing_key_fkey
      foreign key (filing_key) references public.tax_obligations(key) on delete restrict;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'tax_filing_profiles_filing_key_fkey') then
    alter table public.tax_filing_profiles
      add constraint tax_filing_profiles_filing_key_fkey
      foreign key (filing_key) references public.tax_obligations(key) on delete restrict;
  end if;
end $$;

-- The three FK columns are now join targets; tax_filing_profiles.filing_key is
-- already the PK, and tax_schedules/tax_tasks are small, but index them anyway
-- so an obligation delete does not seq-scan to prove RESTRICT.
create index if not exists tax_schedules_filing_key_idx on public.tax_schedules (filing_key);
create index if not exists tax_tasks_filing_key_idx     on public.tax_tasks (filing_key);

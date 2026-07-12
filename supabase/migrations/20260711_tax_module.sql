-- Tax Submission Module: core tables + private Storage bucket
--
-- Four tables backing the Finance -> Tax module (monthly/quarterly/annual
-- filings, starting with NC DOR Sales & Use first party):
--   tax_schedules       — recurring filing cadence per party (frequency, lead time)
--   tax_filing_profiles — per-party static/semi-static values used to prefill worksheets
--   tax_tasks           — one row per filing period, driven off tax_schedules by cron
--   tax_task_files       — uploaded confirmation/support files per task
--
-- Follows the finance-table service-role-only access pattern: RLS enabled,
-- no authenticated access (service_role bypasses RLS). See
-- supabase/migrations/20260711_pos_line_item_taxes.sql for the same pattern
-- applied to a sibling finance table.

create table if not exists public.tax_schedules (
  id           uuid        primary key default gen_random_uuid(),
  party_key    text        not null,
  frequency    text        not null check (frequency in ('monthly', 'quarterly', 'annual')),
  lead_days    int         not null default 7,
  active       boolean     not null default true,
  config       jsonb       not null default '{}',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.tax_filing_profiles (
  party_key    text        primary key,
  values       jsonb       not null default '{}',
  updated_at   timestamptz not null default now()
);

create table if not exists public.tax_tasks (
  id                 uuid        primary key default gen_random_uuid(),
  schedule_id        uuid        not null references public.tax_schedules(id) on delete cascade,
  party_key          text        not null,
  period_start       date        not null,
  period_end         date        not null,
  due_date           date        not null,
  status             text        not null default 'open' check (status in ('open', 'completed', 'skipped')),
  alert_sent_at      timestamptz,
  worksheet          jsonb,
  confirmation_number text,
  amount_paid_cents  int,
  submitted_on       date,
  notes              text,
  completed_at       timestamptz,
  completed_by       uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (schedule_id, period_end)
);

create table if not exists public.tax_task_files (
  id            uuid        primary key default gen_random_uuid(),
  task_id       uuid        not null references public.tax_tasks(id) on delete cascade,
  storage_path  text        not null,
  file_name     text        not null,
  label         text,
  uploaded_at   timestamptz not null default now(),
  uploaded_by   uuid
);

-- ── indexes ───────────────────────────────────────────────────────────────────

create index if not exists tax_tasks_status_due_date_idx
  on public.tax_tasks (status, due_date);

create index if not exists tax_tasks_schedule_id_idx
  on public.tax_tasks (schedule_id);

create index if not exists tax_task_files_task_id_idx
  on public.tax_task_files (task_id);

-- ── column comments ───────────────────────────────────────────────────────────

comment on column public.tax_schedules.party_key is 'party-template key identifying the filing party (e.g. nc_dor_su)';
comment on column public.tax_schedules.lead_days is 'days before due_date that a tax_tasks alert should fire';
comment on column public.tax_schedules.config is 'party-specific schedule config (e.g. day-of-month rules)';
comment on column public.tax_filing_profiles.values is 'party-specific static/semi-static values used to prefill worksheets';
comment on column public.tax_tasks.worksheet is 'editable worksheet payload mirroring the paper filing form';
comment on column public.tax_tasks.amount_paid_cents is 'amount remitted for this filing period, in cents';
comment on column public.tax_task_files.storage_path is 'object path within the tax-confirmations Storage bucket';

-- ── RLS (service-role-only) ───────────────────────────────────────────────────

alter table public.tax_schedules enable row level security;
alter table public.tax_filing_profiles enable row level security;
alter table public.tax_tasks enable row level security;
alter table public.tax_task_files enable row level security;

-- Finance tables are read/written exclusively via the service-role admin client,
-- which bypasses RLS. The policy below denies all authenticated-role access
-- (finance_reader_roles() returns an empty array); service_role is unaffected.
create policy "finance readers" on public.tax_schedules
  for all to authenticated
  using ( public.get_my_role() = any (public.finance_reader_roles()) )
  with check ( public.get_my_role() = any (public.finance_reader_roles()) );

create policy "finance readers" on public.tax_filing_profiles
  for all to authenticated
  using ( public.get_my_role() = any (public.finance_reader_roles()) )
  with check ( public.get_my_role() = any (public.finance_reader_roles()) );

create policy "finance readers" on public.tax_tasks
  for all to authenticated
  using ( public.get_my_role() = any (public.finance_reader_roles()) )
  with check ( public.get_my_role() = any (public.finance_reader_roles()) );

create policy "finance readers" on public.tax_task_files
  for all to authenticated
  using ( public.get_my_role() = any (public.finance_reader_roles()) )
  with check ( public.get_my_role() = any (public.finance_reader_roles()) );

-- ── Storage bucket ─────────────────────────────────────────────────────────────

insert into storage.buckets (id, name, public)
values ('tax-confirmations', 'tax-confirmations', false)
on conflict (id) do nothing;

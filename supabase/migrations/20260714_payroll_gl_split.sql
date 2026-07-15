-- Payroll GL account split: settings, Gusto upload storage, and per-expense
-- GL-line splitting driven by uploaded Gusto payroll reports.
-- See docs/superpowers/specs/2026-07-14-payroll-gl-account-split-design.md

-- ── Settings ─────────────────────────────────────────────────────────────

alter table public.expense_counterparty_mappings
  add column if not exists routing text not null default 'single_account'
    check (routing in ('single_account', 'payroll_split'));

create table if not exists public.payroll_department_gl_mappings (
  id uuid primary key default gen_random_uuid(),
  department_name text not null unique,
  chart_of_accounts_id uuid not null references public.chart_of_accounts(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.payroll_gl_settings (
  id boolean primary key default true check (id),
  payroll_taxes_chart_of_accounts_id uuid not null references public.chart_of_accounts(id)
);

-- ── Gusto upload ─────────────────────────────────────────────────────────

create table if not exists public.payroll_gl_reports (
  id uuid primary key default gen_random_uuid(),
  pay_period_id uuid not null references public.pay_periods(id),
  storage_path text not null,
  original_filename text not null,
  uploaded_at timestamptz not null default now(),
  uploaded_by uuid not null references auth.users(id),
  superseded_at timestamptz
);

create table if not exists public.payroll_gl_report_employees (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.payroll_gl_reports(id) on delete cascade,
  last_name text not null,
  first_name text not null,
  department text not null,
  job text,
  pay_type text,
  gross_amount_cents bigint not null,
  employer_tax_cents bigint not null
);

create table if not exists public.payroll_gl_report_totals (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.payroll_gl_reports(id) on delete cascade,
  chart_of_accounts_id uuid not null references public.chart_of_accounts(id),
  amount_cents bigint not null
);

-- ── Transaction linking + split ──────────────────────────────────────────

create table if not exists public.payroll_period_expense_matches (
  id uuid primary key default gen_random_uuid(),
  pay_period_id uuid not null references public.pay_periods(id),
  expense_id uuid not null unique references public.expenses(id),
  matched_at timestamptz not null default now(),
  matched_by uuid not null references auth.users(id)
);

create table if not exists public.expense_gl_splits (
  id uuid primary key default gen_random_uuid(),
  expense_id uuid not null references public.expenses(id) on delete cascade,
  chart_of_accounts_id uuid not null references public.chart_of_accounts(id),
  amount_cents bigint not null,
  split_source text not null check (split_source in ('payroll_auto', 'manual')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── RLS ───────────────────────────────────────────────────────────────────

alter table public.payroll_department_gl_mappings enable row level security;
alter table public.payroll_gl_settings enable row level security;
alter table public.payroll_gl_reports enable row level security;
alter table public.payroll_gl_report_employees enable row level security;
alter table public.payroll_gl_report_totals enable row level security;
alter table public.payroll_period_expense_matches enable row level security;
alter table public.expense_gl_splits enable row level security;

create policy "payroll readers" on public.payroll_department_gl_mappings
  for all to authenticated
  using ( public.get_my_role() = any (public.payroll_reader_roles()) )
  with check ( public.get_my_role() = any (public.payroll_reader_roles()) );

create policy "payroll readers" on public.payroll_gl_settings
  for all to authenticated
  using ( public.get_my_role() = any (public.payroll_reader_roles()) )
  with check ( public.get_my_role() = any (public.payroll_reader_roles()) );

create policy "payroll readers" on public.payroll_gl_reports
  for all to authenticated
  using ( public.get_my_role() = any (public.payroll_reader_roles()) )
  with check ( public.get_my_role() = any (public.payroll_reader_roles()) );

create policy "payroll readers" on public.payroll_gl_report_employees
  for all to authenticated
  using ( public.get_my_role() = any (public.payroll_reader_roles()) )
  with check ( public.get_my_role() = any (public.payroll_reader_roles()) );

create policy "payroll readers" on public.payroll_gl_report_totals
  for all to authenticated
  using ( public.get_my_role() = any (public.payroll_reader_roles()) )
  with check ( public.get_my_role() = any (public.payroll_reader_roles()) );

create policy "finance readers" on public.payroll_period_expense_matches
  for all to authenticated
  using ( public.get_my_role() = any (public.finance_reader_roles()) )
  with check ( public.get_my_role() = any (public.finance_reader_roles()) );

create policy "finance readers" on public.expense_gl_splits
  for all to authenticated
  using ( public.get_my_role() = any (public.finance_reader_roles()) )
  with check ( public.get_my_role() = any (public.finance_reader_roles()) );

-- ── Storage bucket ────────────────────────────────────────────────────────

insert into storage.buckets (id, name, public)
values ('payroll-gl-reports', 'payroll-gl-reports', false)
on conflict (id) do nothing;

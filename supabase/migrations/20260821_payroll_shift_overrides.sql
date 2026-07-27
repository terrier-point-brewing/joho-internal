-- Per-day payroll overrides for the Shifts grid.
-- adj_* null = fall through to the Square-derived / pool-attributed value.
create table if not exists public.payroll_shift_overrides (
  id            uuid primary key default gen_random_uuid(),
  pay_period_id uuid not null references public.pay_periods(id) on delete cascade,
  employee_id   uuid not null references public.employees(id)   on delete cascade,
  work_date     date not null,
  adj_hours               numeric(8,4),
  adj_paycheck_tips_cents integer,
  adj_cash_tips_cents     integer,
  note          text,
  created_by    uuid,
  updated_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (pay_period_id, employee_id, work_date)
);

create index if not exists payroll_shift_overrides_period_idx
  on public.payroll_shift_overrides (pay_period_id);

comment on table public.payroll_shift_overrides is
  'Manager/admin per-employee-per-day payroll corrections. Rows persist after a period locks (audit trail, and preview recomputes live even for locked periods).';

-- RLS: same shape as the payroll group in 20260709_rls_phase3_tighten_sensitive.sql
alter table public.payroll_shift_overrides enable row level security;

drop policy if exists "payroll readers" on public.payroll_shift_overrides;
create policy "payroll readers" on public.payroll_shift_overrides
  for all to authenticated
  using ( public.get_my_role() = any (public.payroll_reader_roles()) )
  with check ( public.get_my_role() = any (public.payroll_reader_roles()) );

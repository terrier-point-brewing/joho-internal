-- ─── expense_service_periods: the months a bill actually pays for ────────────
--
-- A yearly property-tax bill, an annual insurance premium or a twelve-month
-- licence arrives as ONE expense on ONE date, and the P&L charged all of it to
-- that month. A row here says which days the expense covers; the statements
-- then recognise it an equal share per month covered
-- (lib/finance/servicePeriod.ts), and the part not yet recognised sits on the
-- balance sheet as a prepaid expense.
--
-- One row per expense, and deliberately its own table rather than two columns
-- on `expenses`: the Ramp sync upserts that table wholesale, and an operator's
-- decision about a bill must not be something a sync can overwrite. Same
-- arrangement as expense_gl_splits.
--
-- Nothing is recognised before the bill's own month — earlier service months
-- catch up in the month the bill is dated — so adding or removing a row never
-- changes a month earlier than the bill.

create table if not exists public.expense_service_periods (
  expense_id uuid        primary key references public.expenses(id) on delete cascade,
  start_date date        not null,
  end_date   date        not null,
  created_at timestamptz not null default now(),
  created_by uuid        references auth.users(id),
  updated_at timestamptz not null default now(),
  updated_by uuid        references auth.users(id),
  constraint expense_service_periods_order check (start_date <= end_date)
);

comment on table public.expense_service_periods is
  'The inclusive day range an expense pays for. Present = the P&L spreads the expense over those months instead of charging it all to its accounting_date month; the unrecognised remainder is a prepaid expense on the balance sheet.';

create index if not exists expense_service_periods_end_idx
  on public.expense_service_periods (end_date);

-- Same posture as the other finance tables: every application read and write
-- goes through the service-role admin client behind requirePermission, and
-- apply_grant_policies opens the custom-role path and nothing else.
alter table public.expense_service_periods enable row level security;

select public.apply_grant_policies('expense_service_periods', 'finance.transactions');

drop trigger if exists expense_service_periods_updated_at on public.expense_service_periods;
create trigger expense_service_periods_updated_at
  before insert or update on public.expense_service_periods
  for each row execute function public.update_updated_at();

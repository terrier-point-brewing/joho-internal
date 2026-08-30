-- ============================================================================
-- Depreciation: a standing rule, computed — never a posted journal.
--
-- A schedule says "this fixed-asset account depreciates, straight-line, over
-- this many months, expensed there and accumulated here". Nothing writes
-- monthly rows anywhere: the P&L injects a derived depreciation row, GL 1590
-- computes accumulated depreciation from the same engine, and retained
-- earnings absorbs the same figure — one implementation
-- (lib/finance/depreciation/engine.ts), three readers.
--
-- ── Life changes are PROSPECTIVE. There is deliberately no restating mode ────
-- A change in useful life is a change in accounting estimate, and the standard
-- treatment (ASC 250-10-45-17) is prospective: remaining book value spreads
-- over the remaining new life, and prior periods are never touched.
-- Recomputing history under a new life — the obvious "backfill" — is the
-- treatment reserved for ERROR correction, and building it as a convenience
-- would hand an operator a button that silently rewrites every closed month's
-- P&L. So lives are stored as dated REVISIONS: the row with a NULL
-- effective_month is the life the schedule was created with, and every edit
-- adds a row effective from the month it was made. The engine switches rates
-- at each revision and never revisits the months before it.
--
-- ── NOTHING IS BACKFILLED, NOTHING MOVES ────────────────────────────────────
-- Empty tables. No account changes method, no expense is written, no balance
-- moves by applying this file. Schedules are created by a person in
-- Settings → Finance → Depreciation, and GL 1590 starts computing only when
-- its balance source is switched to the accumulatedDepreciation method.
--
-- Re-runnable end to end.
-- ============================================================================

create table if not exists public.depreciation_schedules (
  id uuid primary key default gen_random_uuid(),
  -- The account whose additions depreciate. One schedule per account: two
  -- lives for one account is two answers to one question.
  asset_chart_of_accounts_id uuid not null unique references public.chart_of_accounts(id),
  -- Where the monthly charge lands on the P&L…
  expense_chart_of_accounts_id uuid not null references public.chart_of_accounts(id),
  -- …and where the contra-asset accumulates on the balance sheet. Carried per
  -- schedule rather than assumed, so a second accumulated-depreciation account
  -- (by asset class, someday) needs no migration.
  contra_chart_of_accounts_id uuid not null references public.chart_of_accounts(id),
  -- Set when the schedule stops accruing (asset disposed of, account retired):
  -- the last month that charges. Accumulated depreciation holds constant after
  -- it rather than vanishing — deleting the schedule outright would erase its
  -- past P&L rows, which are derived, and restate every statement silently.
  ended_month date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.depreciation_life_revisions (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references public.depreciation_schedules(id) on delete cascade,
  -- NULL = the inception life, in force from the first addition onward. A
  -- dated row applies from that month forward — prospectively, see above.
  effective_month date,
  life_months integer not null check (life_months > 0),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);

-- One life per (schedule, effective month). Two partial indexes because NULLs
-- never collide in a plain unique constraint, and two inception lives is
-- exactly the ambiguity this exists to prevent.
create unique index if not exists depreciation_life_revisions_schedule_month_key
  on public.depreciation_life_revisions (schedule_id, effective_month) where effective_month is not null;
create unique index if not exists depreciation_life_revisions_schedule_inception_key
  on public.depreciation_life_revisions (schedule_id) where effective_month is null;

drop trigger if exists depreciation_schedules_updated_at on public.depreciation_schedules;
create trigger depreciation_schedules_updated_at
  before insert or update on public.depreciation_schedules
  for each row execute function public.update_updated_at();

-- Same read/write gate as every other finance rules table.
alter table public.depreciation_schedules enable row level security;
alter table public.depreciation_life_revisions enable row level security;
select public.apply_grant_policies('depreciation_schedules', 'finance.transactions');
select public.apply_grant_policies('depreciation_life_revisions', 'finance.transactions');

-- ─── The chart-of-accounts delete guard ─────────────────────────────────────
-- Restated verbatim from the live definition with ONE arm added (Postgres
-- validates the whole body at CREATE time; there is no appending to it). An
-- account referenced by a schedule in any of its three roles must refuse to
-- delete readably rather than raise a bare 23503.
create or replace function public.coa_reference_count(p_account_id uuid)
returns table(source text, n bigint)
language sql
stable
security definer
set search_path = public
as $$
  select 'account mappings'::text, count(*)::bigint from square_catalog_variations
    where chart_of_accounts_id = p_account_id
       or chart_of_accounts_id_pos = p_account_id
       or chart_of_accounts_id_invoice = p_account_id
  union all
  select 'invoice line items', count(*) from invoice_line_items
    where chart_of_accounts_id = p_account_id
  union all
  select 'POS order line items', count(*) from pos_line_items
    where chart_of_accounts_id = p_account_id
  union all
  select 'expenses', count(*) from expenses
    where chart_of_accounts_id = p_account_id
  union all
  select 'expense account rules', count(*) from expense_account_mappings
    where chart_of_accounts_id = p_account_id
  union all
  select 'expense GL splits', count(*) from expense_gl_splits
    where chart_of_accounts_id = p_account_id
  union all
  select 'bank ledger GL splits', count(*) from bank_ledger_gl_splits
    where chart_of_accounts_id = p_account_id
  union all
  select 'counterparty rules', count(*) from expense_counterparty_mappings
    where chart_of_accounts_id = p_account_id
  union all
  select 'bank ledger lines', count(*) from ramp_bank_ledger
    where chart_of_accounts_id = p_account_id
  union all
  select 'refunds', count(*) from square_refunds
    where chart_of_accounts_id = p_account_id
  union all
  select 'payroll department mappings', count(*) from payroll_department_gl_mappings
    where chart_of_accounts_id = p_account_id
  union all
  select 'payroll tax account', count(*) from payroll_gl_settings
    where payroll_taxes_chart_of_accounts_id = p_account_id
  union all
  select 'manual entries', count(*) from manual_entries
    where chart_of_accounts_id = p_account_id
  union all
  select 'balance sheet account sources', count(*) from balance_sheet_account_sources
    where chart_of_accounts_id = p_account_id
  union all
  select 'depreciation schedules', count(*) from depreciation_schedules
    where asset_chart_of_accounts_id = p_account_id
       or expense_chart_of_accounts_id = p_account_id
       or contra_chart_of_accounts_id = p_account_id
  union all
  select 'GL account balances', count(*) from gl_account_balances
    where chart_of_accounts_id = p_account_id
  union all
  select 'balance close tasks', count(*) from balance_close_tasks
    where chart_of_accounts_id = p_account_id
  union all
  select 'daily balance captures', count(*) from gl_account_daily_balances
    where chart_of_accounts_id = p_account_id
  union all
  select 'child accounts', count(*) from chart_of_accounts
    where parent_id = p_account_id;
$$;

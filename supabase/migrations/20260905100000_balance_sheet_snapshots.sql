-- supabase/migrations/20260905100000_balance_sheet_snapshots.sql
--
-- Foundation for balance-sheet GL mapping: every balance-sheet account gets a
-- declared "balance provider" (lib/finance/balances/registry.ts) that feeds a
-- monthly snapshot, so the Balance Sheet can render month-over-month instead
-- of a single Total column. This migration is schema + seed data only; the
-- providers themselves, the snapshot service, the read path, routes and the
-- Settings screen are later tasks in this feature.
--
-- Sign convention: balance_cents and every provider's compute() return follow
-- the codebase's INTERNAL convention -- assets positive, liabilities and
-- equity NEGATIVE (lib/finance/financials/normalizeSign.ts NEGATIVE_SECTIONS).
-- That is the opposite of a conventionally presented balance sheet; the
-- inversion for display happens in a later task's read path, not here.

-- ── 1. balance_sheet_account_sources ────────────────────────────────────────
-- One row per (account, provider) an account draws a balance from. An account
-- routinely needs more than one provider -- e.g. GL 2220 is tax accruals PLUS
-- tax payments -- so the primary key is the pair, not chart_of_accounts_id
-- alone.
create table if not exists public.balance_sheet_account_sources (
  chart_of_accounts_id uuid        not null references public.chart_of_accounts(id),
  provider_key          text        not null,
  config                 jsonb       not null default '{}',
  active                 boolean     not null default true,
  updated_at             timestamptz not null default now(),
  updated_by             uuid        references auth.users(id),

  primary key (chart_of_accounts_id, provider_key)
);

comment on table public.balance_sheet_account_sources is
  'Declares which balance provider(s) (lib/finance/balances/registry.ts) feed each balance-sheet account''s monthly snapshot. An account may have several providers active at once (e.g. GL 2220 = taxAccrual + transactionPostings).';
comment on column public.balance_sheet_account_sources.provider_key is
  'Matches BalanceProvider.key in lib/finance/balances/registry.ts. Not FK''d -- providers are registered in code, not stored in the DB.';
comment on column public.balance_sheet_account_sources.config is
  'Provider-specific settings, passed through as BalanceContext.config.';

-- ── 2. gl_account_balances ───────────────────────────────────────────────────
-- The computed monthly snapshot itself: one row per (account, period_end).
create table if not exists public.gl_account_balances (
  id                     uuid        primary key default gen_random_uuid(),
  chart_of_accounts_id  uuid        not null references public.chart_of_accounts(id),
  period_end             date        not null,
  balance_cents          bigint      not null,
  contributions           jsonb       not null default '{}',
  is_frozen               boolean     not null default false,
  computed_at             timestamptz not null default now(),

  unique (chart_of_accounts_id, period_end)
);

comment on table public.gl_account_balances is
  'Monthly balance-sheet snapshot per account, internal sign convention (assets positive, liabilities/equity negative). period_end is always a month end.';
comment on column public.gl_account_balances.balance_cents is
  'Internal-convention cents: assets positive, liabilities and equity negative. Do not flip here -- presentation inversion happens in the read path.';
comment on column public.gl_account_balances.contributions is
  'Per-provider breakdown of how balance_cents was assembled, keyed by provider_key.';
comment on column public.gl_account_balances.is_frozen is
  'True once a period has been closed; the snapshot service must not recompute a frozen row.';

create index if not exists gl_account_balances_period_end
  on public.gl_account_balances (period_end);

-- ── 3. balance_close_tasks ───────────────────────────────────────────────────
-- Tracks the manual close workflow for accounts that need a human to confirm
-- or supply a balance before a period can be considered final.
create table if not exists public.balance_close_tasks (
  id                     uuid        primary key default gen_random_uuid(),
  chart_of_accounts_id  uuid        not null references public.chart_of_accounts(id),
  period_end             date        not null,
  due_date                date        not null,
  status                  text        not null default 'open' check (status in ('open', 'completed', 'skipped')),
  alert_sent_at           timestamptz,
  completed_at            timestamptz,
  notes                   text,
  created_at              timestamptz not null default now(),

  unique (chart_of_accounts_id, period_end)
);

comment on table public.balance_close_tasks is
  'Per-account, per-period close checklist item. due_date and alert_sent_at are driven by the balance_sheet_close system_settings row (due_day, alert_lead_days).';

create index if not exists balance_close_tasks_period_status
  on public.balance_close_tasks (period_end, status);

-- ── 4. RLS ────────────────────────────────────────────────────────────────────
-- Lock-down route, not the additive-over-an-existing-policy route.
--
-- apply_grant_policies (20260822_rls_grant_aware_policies.sql) is
-- ADDITIVE-ONLY: its predicate bottoms out in effective_grant_level(), which
-- is gated on `get_my_role() = 'custom'`. On its own, that denies every real
-- viewer/brewer/manager/admin role -- it only ever ADDS access for role =
-- 'custom' on top of an existing policy. On the payroll tables it was always
-- layered over a pre-existing "payroll readers" policy. These three tables
-- have no such sibling, so calling apply_grant_policies alone and stopping
-- there would mean every real user matches NO policy at all, and a SELECT
-- against a table with RLS enabled and zero matching policies returns ZERO
-- ROWS WITH NO ERROR -- which renders as a plausible empty state and would
-- silently zero out anything computed from these tables. (This exact mistake
-- shipped as a blocker in the manual_entries PR, see
-- 20260904120000_manual_entries.sql's own note on the same trap.)
--
-- These three tables are read exclusively through routes that use
-- createSupabaseAdminClient() behind requirePermission() -- the same pattern
-- app/api/finance/chart-of-accounts/route.ts and
-- app/api/finance/expenses/route.ts already use, and the same posture
-- finance_reader_roles() encodes elsewhere: an empty array on purpose, so the
-- Data API surface stays shut and every read goes through an app-level guard.
--
-- So: enable RLS, call apply_grant_policies for defense in depth (it still
-- lets a future 'custom' grant reach these tables if one is ever configured),
-- and add NO broad read policy here. Do not "fix" the apparent gap by adding
-- one -- that would open a Data API surface this table is deliberately never
-- meant to expose.
alter table public.balance_sheet_account_sources enable row level security;
alter table public.gl_account_balances enable row level security;
alter table public.balance_close_tasks enable row level security;

select public.apply_grant_policies('balance_sheet_account_sources', 'finance.transactions');
select public.apply_grant_policies('gl_account_balances',           'finance.statements');
select public.apply_grant_policies('balance_close_tasks',           'finance.statements');

-- ── 5. Audit trail ────────────────────────────────────────────────────────────
-- Reuses the generic function from 20260609_baseline.sql that already backs
-- every other writable finance table. Do not write a new one.
drop trigger if exists balance_sheet_account_sources_audit on public.balance_sheet_account_sources;
create trigger balance_sheet_account_sources_audit
  after insert or update or delete on public.balance_sheet_account_sources
  for each row execute function public.audit_trigger_fn();

drop trigger if exists balance_sheet_account_sources_updated_at on public.balance_sheet_account_sources;
create trigger balance_sheet_account_sources_updated_at
  before update on public.balance_sheet_account_sources
  for each row execute function public.update_updated_at();

drop trigger if exists gl_account_balances_audit on public.gl_account_balances;
create trigger gl_account_balances_audit
  after insert or update or delete on public.gl_account_balances
  for each row execute function public.audit_trigger_fn();

drop trigger if exists balance_close_tasks_audit on public.balance_close_tasks;
create trigger balance_close_tasks_audit
  after insert or update or delete on public.balance_close_tasks
  for each row execute function public.audit_trigger_fn();

-- ── 6. coa_reference_count arms ──────────────────────────────────────────────
-- All three tables carry a chart_of_accounts_id FK with no ON DELETE clause,
-- so without an arm here deleting a referenced account reports zero
-- references and Postgres then raises a raw 23503 instead of the designed 409
-- from app/api/finance/chart-of-accounts/route.ts.
--
-- The whole function body must be restated (language sql bodies are validated
-- at CREATE time), so this is copied from
-- 20260905090000_fix_coa_reference_count.sql -- the CURRENT correct version --
-- and NOT from 20260802_coa_reference_count.sql, which references
-- bs_chart_of_accounts_id / pl_chart_of_accounts_id columns that no longer
-- exist and would abort this migration mid-apply if copied.
create or replace function public.coa_reference_count(p_account_id uuid)
returns table(source text, n bigint)
language sql
stable
security definer
set search_path = public
as $$
  -- bs_/pl_chart_of_accounts_id dropped by 20260802_retire_deposit_recognition_columns.sql
  select 'account mappings'::text, count(*)::bigint from square_catalog_variations
    where chart_of_accounts_id = p_account_id
       or chart_of_accounts_id_pos = p_account_id
       or chart_of_accounts_id_invoice = p_account_id
  union all
  -- same retirement applied here
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
  -- new: 20260905100000_balance_sheet_snapshots.sql
  select 'balance sheet account sources', count(*) from balance_sheet_account_sources
    where chart_of_accounts_id = p_account_id
  union all
  select 'GL account balances', count(*) from gl_account_balances
    where chart_of_accounts_id = p_account_id
  union all
  select 'balance close tasks', count(*) from balance_close_tasks
    where chart_of_accounts_id = p_account_id
  union all
  select 'child accounts', count(*) from chart_of_accounts
    where parent_id = p_account_id;
$$;

comment on function public.coa_reference_count(uuid) is
  'Per-source reference counts for a chart_of_accounts row, backing the per-row Delete guard in Settings > Chart of Accounts. Add an arm here whenever a new table gains a chart_of_accounts_id FK, or that table''s rows will not block a delete and Postgres will raise a raw 23503 instead.';

-- ── 7. Close-config system setting ───────────────────────────────────────────
insert into public.system_settings (key, value)
values ('balance_sheet_close', '{"due_day": 5, "alert_lead_days": 0}'::jsonb)
on conflict (key) do nothing;

-- ── 8. Seed rows ──────────────────────────────────────────────────────────────
-- Mandatory, not illustrative: without these, every account that produces a
-- number today silently goes blank on deploy. Each account is resolved by
-- account_number via a scalar subquery, which fails the whole migration
-- loudly if the number matches zero rows (not-null violation on insert) or
-- more than one (Postgres' own "more than one row returned by a subquery used
-- as an expression" error) -- deliberately not swallowed, unlike
-- 20260827_square_tax_accounts.sql's `limit 1` pattern. 4999 is a known
-- duplicate account_number in this chart of accounts, so resolve-by-number is
-- only safe for the numbers below.
--
-- 2210, 2240 and 2260 are deliberately NOT seeded here: no square_tax_accounts
-- row points at them and they carry no postings, so a source row would
-- compute to nothing and hide them from the unsourced-accounts tile.
--
-- The seed list below is derived from an actual capture of what the pre-PR-B
-- pipeline produced in production, not from reasoning about which accounts
-- "should" have sources -- see lib/finance/balances/__fixtures__/
-- goldenBalanceSheet.ts and scripts/balance-sheet-parity.ts. Two entries exist
-- ONLY because that capture caught their absence:
--
--   * 1310 Security Deposits Paid carries $3,120 of ordinary expense postings.
--     Nothing in the design pointed at it, and it is not a "tax" or "deposit"
--     account anyone thought to enumerate, so it was simply missed. Without
--     this row the account silently reads $0 on the statement.
--   * 2310 needs transactionPostings ALONGSIDE tipAccrual. tipAccrual books
--     tips COLLECTED; the payouts that settle the liability arrive as ordinary
--     expenses (payroll tip disbursements via expense_gl_splits). With the
--     accrual alone the liability is gross tips from inception -- it only ever
--     grows and never settles. Off by 202,529 at capture time.
--
-- Add an account here whenever the parity script reports LOST.
insert into public.balance_sheet_account_sources (chart_of_accounts_id, provider_key)
values
  ((select id from public.chart_of_accounts where account_number = '2220'), 'taxAccrual'),
  ((select id from public.chart_of_accounts where account_number = '2220'), 'transactionPostings'),
  ((select id from public.chart_of_accounts where account_number = '2250'), 'taxAccrual'),
  ((select id from public.chart_of_accounts where account_number = '2250'), 'transactionPostings'),
  ((select id from public.chart_of_accounts where account_number = '2230'), 'transactionPostings'),
  ((select id from public.chart_of_accounts where account_number = '2420'), 'transactionPostings'),
  ((select id from public.chart_of_accounts where account_number = '2430'), 'transactionPostings'),
  ((select id from public.chart_of_accounts where account_number = '1310'), 'transactionPostings'),
  ((select id from public.chart_of_accounts where account_number = '1100'), 'openInvoiceAr'),
  -- openInvoiceAr alone would LOSE any direct posting to A/R. The function it
  -- replaces (injectOpenInvoiceAr) was ADDITIVE over the account's own rows:
  -- it did `existing.amountCentsByMonth[m] + openInvoiceArCents`. 1100 happens
  -- to carry no direct postings today, so parity passes either way -- but the
  -- moment an invoice line, expense or bank row is coded to A/R it would
  -- vanish, and the unsourced tile would not flag 1100 because it HAS a source.
  ((select id from public.chart_of_accounts where account_number = '1100'), 'transactionPostings'),
  ((select id from public.chart_of_accounts where account_number = '2310'), 'tipAccrual'),
  ((select id from public.chart_of_accounts where account_number = '2310'), 'transactionPostings'),
  ((select id from public.chart_of_accounts where account_number = '3300'), 'retainedEarnings')
on conflict (chart_of_accounts_id, provider_key) do nothing;

-- ============================================================================
-- One bank line, several balance-sheet accounts.
--
-- A single wire buys a whole business: $400,625.00 leaves the operating account
-- on 2026-04-21 and arrives as brewery machinery, taproom fixtures, kegs and
-- leasehold improvements. Four accounts, one movement, and the division between
-- them is the asset purchase agreement's price allocation -- something no feed
-- can know. `bank_ledger` carries exactly one `chart_of_accounts_id`, so until
-- now that wire could only be coded to whichever component was biggest, with
-- the other three misstated, or left uncoded while the allocation was typed as
-- free-standing manual entries the bank line itself knew nothing about.
--
-- This is the bank-ledger twin of `expense_gl_splits` (20260714_payroll_gl_split
-- .sql), and deliberately the same shape: the reader REPLACES a split row's own
-- account with its split lines rather than adding to them, so the lines must
-- balance to the parent to the cent. That invariant is enforced in
-- lib/finance/bankLedgerSplits.ts and re-checked in the route before any write.
--
-- ── Only balance-sheet movements are splittable ──────────────────────────────
-- Enforced in code, not by a constraint here, because the rule reads a column on
-- ANOTHER table (`bank_ledger.flow_type`) and a CHECK cannot see it. Spelling it
-- out anyway, since the table would otherwise look more permissive than it is:
--
--   * `operating_expense` / `other_income` reach the P&L, and the P&L's bank
--     fetch (financials/fetchSources.ts) selects one account per row with no
--     split expansion. A split there would be stored and silently ignored.
--   * `card_settlement`, `bill_settlement`, `deposit`, `internal_transfer` use
--     no account at all -- what they move is recorded elsewhere.
--   * `unclassified` has not been answered yet.
--
-- Reclassifying a row out of `balance_sheet_movement` DELETES its splits, the
-- same way that reclassification already clears the row's own account: a
-- posting that survives the flow it belonged to goes on moving a reported
-- balance with nothing on screen admitting it is still there.
--
-- ── NOTHING IS BACKFILLED ───────────────────────────────────────────────────
-- This creates an empty table. Every existing bank line keeps the coding it has;
-- no balance moves as a result of applying this file. The $400,625 allocation is
-- entered by a person afterwards, through the screen, because which asset class
-- got what is a bookkeeping decision and not a migration's to invent.
--
-- Re-runnable end to end.
-- ============================================================================

create table if not exists public.bank_ledger_gl_splits (
  id                   uuid primary key default gen_random_uuid(),
  -- Cascade: a split is a detail OF its line and has no meaning without it.
  -- bank_ledger rows are deleted by the Plaid sync when the bank removes a
  -- pending transaction (plaidTransactionSync.ts), and an orphaned allocation
  -- pointing at a line nobody can see is worse than losing it with the line.
  bank_ledger_id       uuid not null references public.bank_ledger(id) on delete cascade,
  -- No ON DELETE clause, matching expense_gl_splits: deleting an account that
  -- still carries an allocation must fail loudly. coa_reference_count() below
  -- is what turns that into a readable refusal rather than a raw 23503.
  chart_of_accounts_id uuid not null references public.chart_of_accounts(id),
  -- Signed in the same cash direction as the parent (outflow negative), and the
  -- lines must sum to the parent exactly. bigint for the same reason every other
  -- money column is (20261001090002): a half-million-dollar wire is exactly the
  -- kind of row this table exists for.
  amount_cents         bigint not null,
  -- What this slice bought, in the operator's words. The allocation's audit
  -- trail: "APA Schedule 2.1 - brewhouse and cellar" is the difference between a
  -- number somebody can defend and one they will re-derive next year.
  memo                 text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- Both directions are hot: the editor and the row-exclusion pass look up by
-- parent, and the balance-sheet provider looks up by account.
create index if not exists bank_ledger_gl_splits_parent_idx
  on public.bank_ledger_gl_splits (bank_ledger_id);
create index if not exists bank_ledger_gl_splits_coa_idx
  on public.bank_ledger_gl_splits (chart_of_accounts_id);

-- One trigger owns updated_at everywhere in this schema; never set from app code.
drop trigger if exists bank_ledger_gl_splits_updated_at on public.bank_ledger_gl_splits;
create trigger bank_ledger_gl_splits_updated_at
  before insert or update on public.bank_ledger_gl_splits
  for each row execute function public.update_updated_at();

-- ─── RLS ────────────────────────────────────────────────────────────────────
--
-- The parent's policies, not the expense-split ones. `expense_gl_splits` is
-- service-role-only because `expenses` is; `bank_ledger` carries the grant-aware
-- pair for 'finance.transactions', and a detail table that is harder to read
-- than the row it details just means the grid has to fetch it through a
-- different client for no gain. Read needs `read`, any write needs `operate` --
-- the same two answers the parent gives.
alter table public.bank_ledger_gl_splits enable row level security;
select public.apply_grant_policies('bank_ledger_gl_splits', 'finance.transactions');

-- ─── The chart-of-accounts delete guard ─────────────────────────────────────
--
-- Restated verbatim from the live definition with ONE arm added, because
-- Postgres validates the whole body at CREATE time and there is no way to append
-- to it. Every other arm is unchanged, including the `ramp_bank_ledger` one --
-- that is the compat view over `bank_ledger` and its removal is a separate
-- decision, not this file's to make.
--
-- Without the new arm, deleting an account that is still an allocation target
-- reports zero references, the route proceeds, and Postgres raises an opaque
-- 23503 from the FK above.
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

-- Manual guards on the Expenses ledger: exclude-as-duplicate + labelled manual
-- GL splits.
--
-- excluded_* marks a row as a data artifact that must not reach ANY financial
-- statement (P&L, cash flow, balance sheet). This is deliberately stricter than
-- ramp_bank_ledger.affects_pl, which is skipped for the balance sheet so
-- cumulative cash stays correct: an excluded expense is a duplicate whose real
-- cash movement is already carried by another row.
--
-- These columns are NEVER written by the Ramp sync upsert -- they are absent
-- from ExpenseRecord in lib/finance/expenses.ts, and PostgREST's
-- merge-duplicates only SETs supplied columns -- so re-syncs leave them
-- untouched. Same guarantee as inventory_alert_dismissed / unmapped_accepted.
--
-- Human-gated (do NOT auto-apply).
alter table public.expenses
  add column if not exists excluded_at     timestamptz,
  add column if not exists excluded_reason text,
  add column if not exists excluded_by     uuid;

-- Excluded rows are a small minority, so a partial index keeps the
-- "show me what's excluded" filter cheap without bloating the common path.
create index if not exists expenses_excluded_at_idx
  on public.expenses (excluded_at)
  where excluded_at is not null;

-- Labels one component of a manual split, e.g. 'Sales Tax For Utility'.
-- Null for payroll_auto rows, which take their meaning from the pay period.
alter table public.expense_gl_splits
  add column if not exists memo text;

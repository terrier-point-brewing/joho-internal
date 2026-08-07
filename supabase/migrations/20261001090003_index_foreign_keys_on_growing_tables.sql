-- Index the foreign keys that a parent delete actually has to scan.
--
-- An un-indexed FK column costs nothing on SELECT — it costs on the PARENT side.
-- Deleting (or, for ON DELETE SET NULL, updating) a parent row makes Postgres
-- scan the whole child table to enforce the constraint, once per referencing FK.
-- The child is the table that pays, and it pays whether or not anyone ever
-- queries that column.
--
-- WHY NOT ALL 45. An audit on 2026-08-07 found 45 FK columns with no supporting
-- index. Every one of the tables involved is small — the largest, tax_rates, has
-- 117 rows; most have under 80. At those sizes the planner will never choose an
-- index anyway, and a sequential scan of 33 rows during a cascade is free. An
-- index there is pure write-amplification and vacuum work forever, bought
-- against a cost that does not exist. So this indexes on two grounds only:
--
--   1. The FK is ON DELETE CASCADE or SET NULL, so a parent delete does real
--      work in the child rather than merely checking for absence, AND
--   2. the child is on a growth path — it is fed by a recurring sync or an
--      operational cadence (a payroll period, a bank transaction, a production
--      run), not a configuration screen a human edits a handful of times.
--
-- Both, not either. The rest are listed in the PR that carries this migration
-- with the reason each was skipped, so the next audit does not re-litigate them
-- from scratch.
--
-- The chart_of_accounts_id columns earn their index on a third, concrete count:
-- coa_reference_count() (20260802_coa_reference_count.sql, fixed in
-- 20260905090000) scans ~11 tables by chart_of_accounts_id every time someone
-- tries to delete an account, precisely so the delete can be refused with a
-- count instead of silently orphaning rows. That function is the real query
-- path these columns sit on.

-- ── ON DELETE CASCADE: the child is deleted wholesale with its parent ────────

-- Fed one row per expense split; expenses is 271 rows and grows monthly.
create index if not exists expense_gl_splits_expense_id_idx
  on public.expense_gl_splits (expense_id);

-- Both fed per payroll period — 6 reports so far have produced 63 employee rows
-- and 30 total rows, and a period lands every fortnight.
create index if not exists payroll_gl_report_employees_report_id_idx
  on public.payroll_gl_report_employees (report_id);

create index if not exists payroll_gl_report_totals_report_id_idx
  on public.payroll_gl_report_totals (report_id);

-- ── ON DELETE SET NULL: a parent delete rewrites every matching child row ────

-- Grows with every bank transaction the nightly sync pulls.
create index if not exists ramp_bank_ledger_chart_of_accounts_id_idx
  on public.ramp_bank_ledger (chart_of_accounts_id);

-- One row per account per day: the fastest-growing table in this set by
-- construction, and the column a connection teardown would have to rewrite.
create index if not exists gl_account_daily_balances_connection_id_idx
  on public.gl_account_daily_balances (connection_id);

-- ── Plain references on tables the app joins through, and that grow ──────────

-- Filtered by connection on every balance-capture read.
create index if not exists ramp_bank_ledger_connection_id_idx
  on public.ramp_bank_ledger (connection_id);

-- Scanned by coa_reference_count; grows a row per account per payroll period.
create index if not exists payroll_gl_report_totals_chart_of_accounts_id_idx
  on public.payroll_gl_report_totals (chart_of_accounts_id);

-- Scanned by coa_reference_count; grows a row per expense split.
create index if not exists expense_gl_splits_chart_of_accounts_id_idx
  on public.expense_gl_splits (chart_of_accounts_id);

-- The GL report list and every period-scoped payroll read join through this.
create index if not exists payroll_gl_reports_pay_period_id_idx
  on public.payroll_gl_reports (pay_period_id);

-- A transform journal row names the variation on both sides, and the production
-- reads resolve both against packaging_variations. Grows per packaging run.
create index if not exists cold_storage_transforms_from_variation_id_idx
  on public.cold_storage_transforms (from_variation_id);

create index if not exists cold_storage_transforms_to_variation_id_idx
  on public.cold_storage_transforms (to_variation_id);

-- The transform history is read per recipe on the production surfaces.
create index if not exists cold_storage_transforms_recipe_id_idx
  on public.cold_storage_transforms (recipe_id);

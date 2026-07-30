-- supabase/migrations/20260905090000_fix_coa_reference_count.sql
--
-- Repair coa_reference_count, which has been erroring in production.
--
-- SYMPTOM: calling the function returns
--     42703: column "bs_chart_of_accounts_id" does not exist
-- so the per-row Delete in Settings > Chart of Accounts surfaces a 500 instead
-- of the "account is still in use" 409 it was built to produce. The route
-- (app/api/finance/chart-of-accounts/route.ts) calls this RPC to enumerate
-- blockers before deleting; the RPC throws, so the delete path is unusable.
--
-- CAUSE: a migration-version collision, not a logic error.
-- 20260802_coa_reference_count.sql references
-- square_catalog_variations.bs_chart_of_accounts_id / pl_chart_of_accounts_id
-- and invoice_line_items.bs_chart_of_accounts_id / pl_chart_of_accounts_id,
-- while its same-dated sibling 20260802_retire_deposit_recognition_columns.sql
-- DROPS all four. The Supabase CLI keys a migration's version on the digits
-- before the first underscore, so the two files share version 20260802 and
-- applying either marks both applied -- and scripts/check-migrations.mjs
-- grandfathers 20260802 at 2, so the guard reports clean.
--
-- The retirement is deliberate and is the intended end state (see that
-- migration's header: deposit revenue now recognizes immediately via the
-- ordinary chart_of_accounts_id mapping). Verified against production:
--   square_catalog_variations -> chart_of_accounts_id,
--                                chart_of_accounts_id_pos,
--                                chart_of_accounts_id_invoice
--   invoice_line_items        -> chart_of_accounts_id
-- and no code under app/, lib/ or scripts/ reads the bs_/pl_ columns.
-- So the function body is simply stale; this drops the four dead predicates.
--
-- Also adds the missing `manual_entries` arm. That table
-- (20260904120000_manual_entries.sql) has chart_of_accounts_id NOT NULL
-- REFERENCES chart_of_accounts(id) with no ON DELETE clause, so without an arm
-- here the RPC reports zero references, the route proceeds, and Postgres raises
-- an opaque 23503. PR #300 could not add this itself: doing so required
-- restating this whole body, which Postgres validates at CREATE time, so it
-- would have aborted mid-apply on the very columns this migration removes.
--
-- Every other arm is copied verbatim from 20260802_coa_reference_count.sql.

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
  -- new: 20260904120000_manual_entries.sql
  select 'manual entries', count(*) from manual_entries
    where chart_of_accounts_id = p_account_id
  union all
  select 'child accounts', count(*) from chart_of_accounts
    where parent_id = p_account_id;
$$;

comment on function public.coa_reference_count(uuid) is
  'Per-source reference counts for a chart_of_accounts row, backing the per-row Delete guard in Settings > Chart of Accounts. Add an arm here whenever a new table gains a chart_of_accounts_id FK, or that table''s rows will not block a delete and Postgres will raise a raw 23503 instead.';

-- Reference guard for per-row Chart-of-Accounts deletion.
--
-- The Settings → Chart of Accounts per-row Delete (finance UI plan, finding H6)
-- must refuse to delete an account that is still referenced anywhere. Most FKs to
-- chart_of_accounts are ON DELETE SET NULL, so a raw delete would SILENTLY orphan
-- mappings/ledger rows; the rest are NO ACTION and would throw an opaque 23503.
-- This function returns, per source table, how many rows reference the account so
-- the DELETE route can block with a specific, human-readable message.
--
-- NOTE: the CSV bulk-replace flow (POST, delete-by-omission) intentionally keeps
-- its existing SET-NULL behavior and does NOT call this function — only the
-- explicit per-row delete is this strict.
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
       or bs_chart_of_accounts_id = p_account_id
       or pl_chart_of_accounts_id = p_account_id
  union all
  select 'invoice line items', count(*) from invoice_line_items
    where chart_of_accounts_id = p_account_id
       or bs_chart_of_accounts_id = p_account_id
       or pl_chart_of_accounts_id = p_account_id
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
  select 'child accounts', count(*) from chart_of_accounts
    where parent_id = p_account_id;
$$;

grant execute on function public.coa_reference_count(uuid) to service_role, authenticated;

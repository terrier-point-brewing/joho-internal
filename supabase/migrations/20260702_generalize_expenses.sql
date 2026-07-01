-- supabase/migrations/20260702_generalize_expenses.sql
-- Generalize the Ramp-specific expense tables into source-agnostic ones so
-- other spend sources can be added without another rename. A typed `source`
-- column identifies where each record came from; existing rows are Ramp.
--
--   ramp_expenses             -> expenses
--   ramp_gl_account_mappings  -> expense_account_mappings
--   ramp_transaction_id       -> source_transaction_id
--   ramp_gl_id/name/code      -> external_account_id/name/code
--
-- Uniqueness moves from (transaction_id) / (gl_id) to (source, ...) so ids from
-- different sources can't collide.

-- ── expenses (was ramp_expenses) ─────────────────────────────────────────────
alter table public.ramp_expenses rename to expenses;

alter table public.expenses rename column ramp_transaction_id to source_transaction_id;
alter table public.expenses rename column ramp_gl_id          to external_account_id;
alter table public.expenses rename column ramp_gl_name        to external_account_name;
alter table public.expenses rename column ramp_gl_code        to external_account_code;

alter table public.expenses
  add column source text not null default 'ramp'
    check (source in ('ramp', 'square', 'manual'));
alter table public.expenses alter column source drop default;

alter table public.expenses drop constraint ramp_expenses_ramp_transaction_id_key;
alter table public.expenses add constraint expenses_source_txn_unique unique (source, source_transaction_id);

alter table public.expenses rename constraint ramp_expenses_chart_of_accounts_id_fkey to expenses_chart_of_accounts_id_fkey;

alter index if exists idx_ramp_expenses_gl_id           rename to idx_expenses_external_account_id;
alter index if exists idx_ramp_expenses_coa             rename to idx_expenses_coa;
alter index if exists idx_ramp_expenses_accounting_date rename to idx_expenses_accounting_date;

alter trigger ramp_expenses_updated_at on public.expenses rename to expenses_updated_at;

alter policy "Authenticated users can read ramp expenses" on public.expenses rename to "Authenticated users can read expenses";
alter policy "Admins can manage ramp expenses"            on public.expenses rename to "Admins can manage expenses";

-- ── expense_account_mappings (was ramp_gl_account_mappings) ───────────────────
alter table public.ramp_gl_account_mappings rename to expense_account_mappings;

alter table public.expense_account_mappings rename column ramp_gl_id   to external_account_id;
alter table public.expense_account_mappings rename column ramp_gl_name to external_account_name;
alter table public.expense_account_mappings rename column ramp_gl_code to external_account_code;

alter table public.expense_account_mappings
  add column source text not null default 'ramp'
    check (source in ('ramp', 'square', 'manual'));
alter table public.expense_account_mappings alter column source drop default;

alter table public.expense_account_mappings drop constraint ramp_gl_account_mappings_ramp_gl_id_key;
alter table public.expense_account_mappings add constraint expense_account_mappings_source_account_unique unique (source, external_account_id);

alter table public.expense_account_mappings rename constraint ramp_gl_account_mappings_chart_of_accounts_id_fkey to expense_account_mappings_chart_of_accounts_id_fkey;

alter index if exists idx_ramp_gl_account_mappings_coa rename to idx_expense_account_mappings_coa;

alter trigger ramp_gl_account_mappings_updated_at on public.expense_account_mappings rename to expense_account_mappings_updated_at;

alter policy "Authenticated users can read ramp gl mappings" on public.expense_account_mappings rename to "Authenticated users can read expense mappings";
alter policy "Admins can manage ramp gl mappings"           on public.expense_account_mappings rename to "Admins can manage expense mappings";

-- The shared updated_at trigger function is no longer Ramp-specific.
alter function public.set_ramp_updated_at() rename to set_expense_updated_at;

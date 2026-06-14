alter table public.chart_of_accounts
  add column if not exists parent_id uuid references public.chart_of_accounts(id) on delete set null,
  add column if not exists statement_section text;

comment on column public.chart_of_accounts.parent_id is 'Self-referencing FK for sub-account hierarchy';
comment on column public.chart_of_accounts.statement_section is 'Explicit override for P&L/Balance Sheet section; NULL = inferred from account_type';

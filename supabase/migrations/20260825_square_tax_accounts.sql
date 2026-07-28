-- square_tax_accounts: maps each Square catalog tax to the balance-sheet
-- liability account its collections are credited to.
--
-- Sales tax collected from customers is money held for NC DOR / Wake County,
-- not revenue. Rows are seeded automatically from observed pos_line_item_taxes
-- /invoice_line_item_taxes by lib/finance/salesTaxAccounts.ts, so a new Square
-- tax surfaces in settings instead of being silently dropped.
--
-- Service-role-only access, matching the pos_line_item_taxes policy shape.

create table if not exists public.square_tax_accounts (
  square_tax_id        text        primary key,
  tax_name             text,
  tax_pct              numeric,
  chart_of_accounts_id uuid        references public.chart_of_accounts(id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

comment on column public.square_tax_accounts.chart_of_accounts_id is
  'Other Current Liabilities account credited on collection; NULL = unmapped, emits no accrual';
comment on column public.square_tax_accounts.tax_name is
  'Last-seen Square label, display only -- the map keys on square_tax_id';

-- Seed the two taxes observed in prod. The scalar subquery yields NULL when the
-- account name does not match, leaving the row unmapped (safe: no accrual) --
-- deliberately NOT a hard failure, which would block the whole migration.
insert into public.square_tax_accounts (square_tax_id, tax_name, tax_pct, chart_of_accounts_id)
values
  ('ADD7EKQD2KN72NOYVUWHU34J', 'General Sales Tax', 7.25,
   (select id from public.chart_of_accounts
     where account_name = 'Sales & Excise Taxes Payable:North Carolina Department of Revenue Payable'
     limit 1)),
  ('ARI25PLSGLDVIBUQITKTRNSX', 'Prepared Food & Beverage Tax', 1,
   (select id from public.chart_of_accounts
     where account_name = 'Sales & Excise Taxes Payable:Out Of Scope Agency Payable'
     limit 1))
on conflict (square_tax_id) do nothing;

alter table public.square_tax_accounts enable row level security;

create policy "finance readers" on public.square_tax_accounts
  for all to authenticated
  using ( public.get_my_role() = any (public.finance_reader_roles()) )
  with check ( public.get_my_role() = any (public.finance_reader_roles()) );

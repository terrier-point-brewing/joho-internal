-- Manual "this doesn't need a real GL mapping" dismissal, one column per
-- Transactions-tab source table. Mirrors expenses.inventory_alert_dismissed.
alter table public.square_orders    add column if not exists unmapped_accepted boolean not null default false;
alter table public.invoices         add column if not exists unmapped_accepted boolean not null default false;
alter table public.expenses         add column if not exists unmapped_accepted boolean not null default false;
alter table public.ramp_bank_ledger add column if not exists unmapped_accepted boolean not null default false;

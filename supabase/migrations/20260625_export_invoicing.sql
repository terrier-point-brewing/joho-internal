-- Spec 6: Export Transactions Unified Invoicing
-- Adds invoice tracking to export_transactions, per-partner net-terms
-- override, and a global net-terms default in system_settings.

alter table public.export_transactions
  add column square_invoice_id text;

alter table public.contract_brewing_partners
  add column export_net_terms_days integer;

insert into public.system_settings (key, value)
values ('export_invoice_due_days', '30'::jsonb)
on conflict (key) do nothing;

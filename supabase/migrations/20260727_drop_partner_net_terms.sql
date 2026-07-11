-- Drop per-partner invoice net-terms overrides.
--
-- Net terms are now a single configured value per invoice type, stored in
-- system_settings (deposit_invoice_due_days / export_invoice_due_days) and
-- edited from Production → Settings. The per-partner override columns are no
-- longer read by any code path.
--
-- Apply ONLY after the code that stops selecting these columns has deployed.
alter table public.contract_brewing_partners
  drop column if exists export_net_terms_days,
  drop column if exists deposit_net_terms_days;

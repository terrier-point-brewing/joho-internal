-- Deposit recognition: BS/PL split mapping on invoice line items
-- and deposit mapping config on catalog variations.
--
-- invoice_line_items gains four columns:
--   bs_chart_of_accounts_id  — where the line item sits until delivery
--   pl_chart_of_accounts_id  — where it moves when delivery invoice is paid
--   delivery_invoice_id      — the invoice whose payment triggers recognition
--   account_mode             — manual override: force_bs | force_pl | NULL (automatic)
--
-- square_catalog_variations gains two columns for the same BS/PL config,
-- which are prefilled onto invoice_line_items during Square invoice sync.

ALTER TABLE invoice_line_items
  ADD COLUMN IF NOT EXISTS bs_chart_of_accounts_id uuid REFERENCES chart_of_accounts(id),
  ADD COLUMN IF NOT EXISTS pl_chart_of_accounts_id uuid REFERENCES chart_of_accounts(id),
  ADD COLUMN IF NOT EXISTS delivery_invoice_id     uuid REFERENCES invoices(id),
  ADD COLUMN IF NOT EXISTS account_mode            text CHECK (account_mode IN ('force_bs', 'force_pl'));

ALTER TABLE square_catalog_variations
  ADD COLUMN IF NOT EXISTS bs_chart_of_accounts_id uuid REFERENCES chart_of_accounts(id),
  ADD COLUMN IF NOT EXISTS pl_chart_of_accounts_id uuid REFERENCES chart_of_accounts(id);

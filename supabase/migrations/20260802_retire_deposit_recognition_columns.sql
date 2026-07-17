-- Retire the contract-brewing "deposit recognition" deferred-revenue feature.
--
-- Deposit revenue now recognizes immediately on the invoice date via the
-- ordinary chart_of_accounts_id mapping (lib/finance/financials/aggregateRows.ts
-- resolveInvoice books every line to chart_of_accounts_id). The old model parked
-- deposits on a balance-sheet liability until a linked delivery invoice was paid,
-- but that trigger never fired (delivery/export invoices don't carry the
-- materials-pass-through revenue, and delivery_invoice_id / account_mode were
-- never populated on a single row), so deposit revenue was permanently stranded
-- off the P&L.
--
-- ORDER MATTERS: the backfill below MUST run before the pl_chart_of_accounts_id
-- drop. Some historical deposit lines still carry chart_of_accounts_id = a
-- balance-sheet liability account (e.g. the May 2026 straggler on acct 2430,
-- and the July lines on the "Customer Deposits" acct) with the 4320 revenue
-- account only in pl_chart_of_accounts_id. The backfill promotes chart_of_
-- accounts_id to 4320 for every such line so nothing regresses when pl is dropped.

-- 1. Backfill: normalize every non-voided contract-brewing deposit line to the
--    4320 revenue account. Resolves 4320 by account_number (a no-op if, for any
--    reason, no 4320 account exists), and skips lines already on it.
update invoice_line_items ili
set chart_of_accounts_id = coa.id
from invoices i, chart_of_accounts coa
where ili.invoice_id = i.id
  and i.invoice_type = 'allocation_deposit'
  and i.status <> 'voided'
  and coa.account_number = '4320'
  and ili.chart_of_accounts_id is distinct from coa.id;

-- 2. Drop the now-dead deferred-revenue columns.
alter table invoice_line_items
  drop column if exists bs_chart_of_accounts_id,
  drop column if exists pl_chart_of_accounts_id,
  drop column if exists delivery_invoice_id,
  drop column if exists account_mode;

alter table square_catalog_variations
  drop column if exists bs_chart_of_accounts_id,
  drop column if exists pl_chart_of_accounts_id;

-- When a contract-brewing allocation's ingredient deposit was never paid up
-- front, the deposit can be back-charged as a line on the export invoice
-- instead. This column records WHICH export invoice carries that charge, so:
--   * the Commitments Invoicing cell can show "On export invoice #N", and
--   * when that invoice is paid, the allocation's deposit is stamped paid
--     automatically (settleBackchargedDeposits), and if the invoice is voided
--     the pointer clears and the deposit goes back to pending.
-- NULL means the deposit is expected through its own deposit invoice.
alter table batch_allocations
  add column deposit_backcharged_invoice_id uuid references invoices(id) on delete set null;

comment on column batch_allocations.deposit_backcharged_invoice_id is
  'Export invoice (invoices.id) carrying this allocation''s back-charged ingredient deposit; null when the deposit bills through its own deposit invoice.';

-- The settle path looks allocations up by invoice on every paid/voided flip.
create index idx_batch_allocations_deposit_backcharge
  on batch_allocations (deposit_backcharged_invoice_id)
  where deposit_backcharged_invoice_id is not null;

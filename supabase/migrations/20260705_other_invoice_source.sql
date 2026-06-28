-- Add 'other' to invoices.source so non-Square, non-QB ledger entries can be stored.
-- 'quickbooks' was already valid; 'square' stays. 'other' is for catch-all manual records.
-- mark_paid backfill routes enforce source = 'quickbooks' — 'other' is available in the
-- enum but intentionally not accepted by any action that mutates allocation/export state.

alter table public.invoices
  drop constraint invoices_source_check,
  add constraint invoices_source_check
    check (source in ('quickbooks', 'square', 'other'));

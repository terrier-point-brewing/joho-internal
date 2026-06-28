-- Add 'other' to invoices.source so non-Square, non-QB ledger entries can be stored.
-- 'quickbooks' was already valid; 'square' stays. 'other' is for catch-all manual records.
-- Both 'record' and 'mark_paid' actions accept source = 'other' for non-QB external records.
-- 'other' is intentional for catch-all manual records not linked to Square or QuickBooks.

alter table public.invoices
  drop constraint invoices_source_check,
  add constraint invoices_source_check
    check (source in ('quickbooks', 'square', 'other'));

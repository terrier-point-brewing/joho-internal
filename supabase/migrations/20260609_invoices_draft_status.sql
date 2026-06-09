-- Add "draft" to the invoices status check constraint
ALTER TABLE invoices DROP CONSTRAINT invoices_status_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_status_check
  CHECK (status IN ('open', 'paid', 'voided', 'partial', 'unknown', 'draft'));

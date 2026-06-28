-- Allocation locking is now fully implied by invoice_paid_at IS NOT NULL.
-- Manual locking has been removed from the UI and API; these columns are
-- dead weight that could drift out of sync with invoice_paid_at.
ALTER TABLE batch_allocations
  DROP COLUMN IF EXISTS locked,
  DROP COLUMN IF EXISTS lock_reason,
  DROP COLUMN IF EXISTS locked_at;

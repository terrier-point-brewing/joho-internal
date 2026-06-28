-- Fix missing invoice_batch_links for deposit invoices that have allocation_id set
-- but no corresponding batch link. The B-021 backfill set allocation-level fields
-- directly in the DB but missed creating the invoice_batch_links row.
-- This migration also covers any future gaps caused by the same pattern.

INSERT INTO invoice_batch_links (invoice_id, batch_id)
SELECT
  i.id,
  ba.batch_id
FROM invoices i
JOIN batch_allocations ba ON ba.id = i.allocation_id
WHERE i.invoice_type = 'allocation_deposit'
  AND i.status != 'voided'
  AND NOT EXISTS (
    SELECT 1 FROM invoice_batch_links ibl
    WHERE ibl.invoice_id = i.id AND ibl.batch_id = ba.batch_id
  )
ON CONFLICT (invoice_id, batch_id) DO NOTHING;

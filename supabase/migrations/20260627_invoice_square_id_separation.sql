-- Separate the Square system invoice ID from the human-readable invoice number.
--
-- Previously, invoices.external_id held both roles for Square rows:
--   - deduplication key for upserts  (still its job after this migration)
--   - join target from batch_allocations.square_deposit_invoice_id
--   - UI fallback when invoice_number is null
--
-- This migration adds invoices.square_invoice_id as the dedicated, named column
-- for the Square invoice ID.  invoice_number remains exclusively for the
-- human-readable sequential number (000001, 000002, …).

-- ── 1. Add column ─────────────────────────────────────────────────────────────
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS square_invoice_id text;

-- ── 2. Backfill from external_id for Square rows ──────────────────────────────
UPDATE invoices
  SET square_invoice_id = external_id
  WHERE source = 'square';

-- ── 3. Partial unique index ───────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS invoices_square_invoice_id_key
  ON invoices (square_invoice_id)
  WHERE square_invoice_id IS NOT NULL;

-- ── 4. Fix any invoice_number values that got the Square system ID as fallback
--      (from the `inv.invoice_number ?? inv.id` pattern in syncSquareInvoices).
--      No such rows exist today, but ensures a provably clean state.
UPDATE invoices
  SET invoice_number = NULL
  WHERE source = 'square'
    AND invoice_number = external_id;

-- ── 5. Fix batch_allocations rows missing the inv: prefix on square_deposit_invoice_id
--      (B-021 was manually backfilled without it; all Square IDs must carry the prefix
--      so that the join .eq("square_invoice_id", square_deposit_invoice_id) matches).
UPDATE batch_allocations
  SET square_deposit_invoice_id = 'inv:' || square_deposit_invoice_id
  WHERE square_deposit_invoice_id IS NOT NULL
    AND square_deposit_invoice_id NOT LIKE 'inv:%';

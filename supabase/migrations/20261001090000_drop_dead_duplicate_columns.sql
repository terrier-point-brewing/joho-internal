-- Drop columns that a logical audit proved are duplicates or dead.
--
-- Every column below is either an exact copy of a column that stays, or 100%
-- NULL across every row in the table. Nothing here loses a fact: the audit
-- checked populated counts against production before this was written.
--
-- Deliberately no CASCADE. If some view or index turns out to depend on one of
-- these, the migration should fail loudly rather than quietly drop the
-- dependent object too.

-- ── 1. pos_line_items.square_catalog_object_id ───────────────────────────────
-- An exact duplicate of square_variation_id: both are written from the same
-- `varId` in lib/finance/syncPosTransactions.ts, and 0 of 5,361 rows differ.
-- Guard the assumption rather than trusting the audit, since this is the one
-- column here that actually holds data.
DO $$
DECLARE
  mismatched bigint;
BEGIN
  SELECT count(*) INTO mismatched
  FROM public.pos_line_items
  WHERE square_catalog_object_id IS DISTINCT FROM square_variation_id;

  IF mismatched > 0 THEN
    RAISE EXCEPTION
      'Refusing to drop pos_line_items.square_catalog_object_id: % row(s) differ from square_variation_id',
      mismatched;
  END IF;
END $$;

ALTER TABLE public.pos_line_items DROP COLUMN IF EXISTS square_catalog_object_id;

-- ── 2. square_catalog_variations.service_duration_ms ─────────────────────────
-- Square's appointment-booking duration. A brewery never sets it: 0 of 459
-- rows populated, and nothing has ever read it back.
ALTER TABLE public.square_catalog_variations DROP COLUMN IF EXISTS service_duration_ms;

-- ── 3. invoice_line_items.notes ──────────────────────────────────────────────
-- 0 of 179 rows populated, no readers, no writers. NOT to be confused with the
-- singular `note` column on the same table, which is in active use (91 of 179
-- rows populated) and stays exactly where it is.
ALTER TABLE public.invoice_line_items DROP COLUMN IF EXISTS notes;

-- ── 4. pos_line_items.category ───────────────────────────────────────────────
-- 0 of 5,361 rows populated, never written, never read. Line-item
-- categorisation lives on invoice_line_items.category, which stays.
ALTER TABLE public.pos_line_items DROP COLUMN IF EXISTS category;

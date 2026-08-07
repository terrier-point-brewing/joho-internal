-- Collapse invoice_line_items.description into the columns that already hold
-- its two meanings, then drop it.
--
-- `description` was doing double duty across two disjoint kinds of row:
--
--   Square/catalog-synced rows (157 of 179, `line_item_name` populated) kept a
--   DERIVED concatenation, `line_item_name || ' — ' || variation_name`. It is a
--   stored copy of something already held atomically, and it had already gone
--   stale on 2 rows whose catalog item gained a "(Keg)" suffix the copy never
--   picked up — the builder composed it from the ORDER's line name while
--   `line_item_name` came from the CATALOG. Composing at display time instead
--   makes that class of drift impossible.
--
--   Manually-entered rows (22 of 179, `line_item_name` NULL) have no catalog
--   identity, and their `description` is the real per-line note. Those move to
--   `note`, which is where every other note on this table already lives.
--
-- After this, a line item is a LABEL (line_item_name + variation_name, composed
-- on read) and a NOTE (note). Nothing stores the composition.

-- ── 1. Guard: the backfill must not overwrite an existing note ───────────────
-- Verified 2026-08-07: all 22 manual rows have note IS NULL, so the move is
-- unambiguous. Re-check rather than trust it — if any row has since gained a
-- note, that note is a fact this migration must not silently destroy.
DO $$
DECLARE
  colliding bigint;
BEGIN
  SELECT count(*) INTO colliding
  FROM public.invoice_line_items
  WHERE line_item_name IS NULL
    AND description IS NOT NULL
    AND note IS NOT NULL;

  IF colliding > 0 THEN
    RAISE EXCEPTION
      'Refusing to collapse invoice_line_items.description: % manual row(s) already have a note that the backfill would overwrite',
      colliding;
  END IF;
END $$;

-- ── 2. Backfill the manual rows' text into `note` ───────────────────────────
-- Scoped to line_item_name IS NULL: catalog-backed rows already hold their real
-- note in `note` (91 of 157 populated), and their `description` is only the
-- derived label, which must NOT be written over a genuine note or invented as
-- one where the line has none.
UPDATE public.invoice_line_items
SET note = description
WHERE line_item_name IS NULL
  AND description IS NOT NULL
  AND note IS NULL;

-- ── 3. Drop the column ──────────────────────────────────────────────────────
-- Deliberately no CASCADE: if some view or index turns out to depend on this,
-- fail loudly rather than quietly drop the dependent object too.
ALTER TABLE public.invoice_line_items DROP COLUMN IF EXISTS description;

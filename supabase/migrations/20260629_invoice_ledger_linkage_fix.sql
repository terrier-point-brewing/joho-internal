-- Invoice ledger linkage fix (2026-06-29)
-- 1. Extend invoice_type to include 'export_invoice'
-- 2. Extend invoice_line_items.category to include 'ingredient_deposit'
-- 3. Backfill existing export invoices to invoice_type = 'export_invoice'
-- 4. Create missing invoice_batch_links for export invoices
-- 5. Fix 'other' source rows wrongly stored as 'quickbooks'
-- 6. Fix deposit line items from 'other_services' to 'ingredient_deposit'

-- ── 1. Extend invoice_type ────────────────────────────────────────────────────
ALTER TABLE public.invoices
  DROP CONSTRAINT IF EXISTS invoices_invoice_type_check;
ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_invoice_type_check
  CHECK (invoice_type IN ('standard', 'allocation_deposit', 'export_invoice'));

-- ── 2. Extend invoice_line_items.category ─────────────────────────────────────
ALTER TABLE public.invoice_line_items
  DROP CONSTRAINT IF EXISTS invoice_line_items_category_check;
ALTER TABLE public.invoice_line_items
  ADD CONSTRAINT invoice_line_items_category_check
  CHECK (category IN (
    'ingredient_deposit',
    'materials_packaging',
    'packaging_fees',
    'other_services',
    'pass_through_taxes',
    'distribution_keg',
    'distribution_can',
    'other'
  ));

-- ── 3. Backfill invoice_type for existing export invoices ─────────────────────
-- Export invoices are identified by the existence of an export_transactions row
-- pointing to them. QB-imported standard invoices have no such link.
UPDATE public.invoices i
SET invoice_type = 'export_invoice'
WHERE i.invoice_type = 'standard'
  AND EXISTS (
    SELECT 1 FROM public.export_transactions et
    WHERE et.invoice_id = i.id
  );

-- ── 4. Create missing invoice_batch_links for export invoices ─────────────────
-- Each export invoice should have a link for every distinct batch across its
-- transactions. These were never created at generation time.
INSERT INTO public.invoice_batch_links (invoice_id, batch_id)
SELECT DISTINCT et.invoice_id, et.batch_id
FROM public.export_transactions et
WHERE et.invoice_id IS NOT NULL
  AND et.batch_id IS NOT NULL
ON CONFLICT (invoice_id, batch_id) DO NOTHING;

-- ── 5. Fix 'other' source rows stored as 'quickbooks' ────────────────────────
-- The 'record' and 'mark_paid' actions had a bug that always wrote 'quickbooks'
-- even when source was 'other'. These rows are safely identified by their
-- external_id pattern (generated as 'other:<uuid>' for non-QB manual records).
UPDATE public.invoices
SET source = 'other'
WHERE source = 'quickbooks'
  AND external_id LIKE 'other:%';

-- ── 6. Fix deposit line item categories ───────────────────────────────────────
-- Deposit line items were stored as 'other_services'; correct category is
-- 'ingredient_deposit' which maps to a separate GL account from packaging materials.
UPDATE public.invoice_line_items
SET category = 'ingredient_deposit'
WHERE description = 'Ingredient Deposit'
  AND category = 'other_services';

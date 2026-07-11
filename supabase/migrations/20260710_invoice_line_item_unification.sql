-- 20260710_invoice_line_item_unification.sql
-- Unify export/deposit/sync invoice line items onto one canonical shape.

-- 1. Snapshot catalog item name (variation_name already exists).
ALTER TABLE public.invoice_line_items
  ADD COLUMN IF NOT EXISTS line_item_name text;

-- 2. Invoice-level (order-scoped) discount total.
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS discount_cents bigint;

-- 3. Consolidate the three catalog-ref columns into square_catalog_variation_id.
UPDATE public.invoice_line_items
   SET square_catalog_variation_id = COALESCE(square_catalog_variation_id, square_variation_id, square_catalog_object_id)
 WHERE square_catalog_variation_id IS NULL
   AND (square_variation_id IS NOT NULL OR square_catalog_object_id IS NOT NULL);

COMMENT ON COLUMN public.invoice_line_items.line_item_name IS 'Snapshot of Square catalog item name at invoicing (col 1 = line_item_name — variation_name).';
COMMENT ON COLUMN public.invoices.discount_cents IS 'Order-scoped (invoice-level) discount total in cents; line-scoped discounts live on invoice_line_items.discount_cents.';

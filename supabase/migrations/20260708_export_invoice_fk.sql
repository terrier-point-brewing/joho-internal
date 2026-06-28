-- supabase/migrations/20260708_export_invoice_fk.sql
-- Export UI redesign: replace export_transactions.square_invoice_id with
-- a proper FK to invoices(id), add 'draft' status to invoices, and add
-- square_catalog_variation_id to invoice_line_items for draft editing.

-- 1. Add invoice_id FK column to export_transactions
ALTER TABLE public.export_transactions
  ADD COLUMN IF NOT EXISTS invoice_id uuid
  REFERENCES public.invoices(id) ON DELETE SET NULL;

-- 2. Backfill invoice_id from the invoices table via square_invoice_id match
UPDATE public.export_transactions et
SET invoice_id = inv.id
FROM public.invoices inv
WHERE et.square_invoice_id = inv.square_invoice_id
  AND inv.square_invoice_id IS NOT NULL
  AND et.invoice_id IS NULL;

-- 3. Drop the old square_invoice_id column from export_transactions
ALTER TABLE public.export_transactions
  DROP COLUMN IF EXISTS square_invoice_id;

-- 4. Extend invoices.status to include 'draft'
ALTER TABLE public.invoices
  DROP CONSTRAINT IF EXISTS invoices_status_check;
ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_status_check
  CHECK (status IN ('draft', 'open', 'paid', 'voided', 'partial', 'unknown'));

-- 5. Add square_catalog_variation_id to invoice_line_items
--    (stored at generate time so the PATCH route can recreate the Square
--    invoice with the correct catalog items after adding/removing a line)
ALTER TABLE public.invoice_line_items
  ADD COLUMN IF NOT EXISTS square_catalog_variation_id text;

-- 6. Index for FK lookups (export_transactions by invoice)
CREATE INDEX IF NOT EXISTS export_transactions_invoice_id_idx
  ON public.export_transactions (invoice_id);

-- Add missing columns to pos_line_items for parity with invoice_line_items
ALTER TABLE public.pos_line_items
  ADD COLUMN IF NOT EXISTS variation_name text,
  ADD COLUMN IF NOT EXISTS category       text,
  ADD COLUMN IF NOT EXISTS raw_data       jsonb;

-- Add missing columns to invoice_line_items for parity with pos_line_items
ALTER TABLE public.invoice_line_items
  ADD COLUMN IF NOT EXISTS tax_cents  bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS notes      text;

-- updated_at trigger for invoice_line_items
CREATE TRIGGER invoice_line_items_updated_at
  BEFORE UPDATE ON public.invoice_line_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

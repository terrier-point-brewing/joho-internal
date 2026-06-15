-- Rename square_transactions → square_orders
-- Rename square_transaction_line_items → pos_line_items
-- Add invoice_id FK to square_orders
-- Migrate invoice-sourced line items from pos_line_items → invoice_line_items
-- Add Square catalog columns to invoice_line_items to preserve item metadata

-- 1. Rename the tables
ALTER TABLE public.square_transactions RENAME TO square_orders;
ALTER TABLE public.square_transaction_line_items RENAME TO pos_line_items;

-- 2. Rename the FK column on pos_line_items to match (transaction_id → order_id)
ALTER TABLE public.pos_line_items RENAME COLUMN transaction_id TO order_id;

-- 3. Rename constraints to match new names
ALTER TABLE public.pos_line_items
  RENAME CONSTRAINT square_transaction_line_items_transaction_id_fkey
  TO pos_line_items_order_id_fkey;

ALTER TABLE public.pos_line_items
  RENAME CONSTRAINT square_transaction_line_items_chart_of_accounts_id_fkey
  TO pos_line_items_chart_of_accounts_id_fkey;

-- 4. Add invoice_id FK to square_orders
ALTER TABLE public.square_orders
  ADD COLUMN IF NOT EXISTS invoice_id uuid REFERENCES public.invoices(id) ON DELETE SET NULL;

-- Populate invoice_id by matching square_orders.square_order_id to invoices.raw_data->>'square_order_id'
UPDATE public.square_orders so
SET invoice_id = i.id
FROM public.invoices i
WHERE i.raw_data->>'square_order_id' = so.square_order_id;

CREATE INDEX IF NOT EXISTS square_orders_invoice_id_idx ON public.square_orders(invoice_id);

-- 5. Add Square catalog columns to invoice_line_items so migrated rows retain item metadata
ALTER TABLE public.invoice_line_items
  ADD COLUMN IF NOT EXISTS square_catalog_object_id text,
  ADD COLUMN IF NOT EXISTS square_variation_id       text,
  ADD COLUMN IF NOT EXISTS gross_sales_cents         bigint,
  ADD COLUMN IF NOT EXISTS discount_cents            bigint,
  ADD COLUMN IF NOT EXISTS net_sales_cents           bigint,
  ADD COLUMN IF NOT EXISTS square_line_item_uid      text;

-- 6. Migrate line items from pos_line_items → invoice_line_items for invoice-backed orders
INSERT INTO public.invoice_line_items (
  invoice_id,
  sort_order,
  description,
  quantity,
  unit_price_cents,
  total_cents,
  gross_sales_cents,
  discount_cents,
  net_sales_cents,
  square_catalog_object_id,
  square_variation_id,
  square_line_item_uid,
  chart_of_accounts_id,
  raw_data,
  created_at
)
SELECT
  so.invoice_id,
  ROW_NUMBER() OVER (PARTITION BY pl.order_id ORDER BY pl.id)::int AS sort_order,
  pl.name                    AS description,
  pl.quantity,
  pl.base_price_cents        AS unit_price_cents,
  pl.net_sales_cents         AS total_cents,
  pl.gross_sales_cents,
  pl.discount_cents,
  pl.net_sales_cents,
  pl.square_catalog_object_id,
  pl.square_variation_id,
  pl.square_line_item_uid,
  pl.chart_of_accounts_id,
  NULL                       AS raw_data,
  pl.created_at
FROM public.pos_line_items pl
JOIN public.square_orders so ON so.id = pl.order_id
WHERE so.invoice_id IS NOT NULL;

-- 7. Delete the migrated rows from pos_line_items
DELETE FROM public.pos_line_items
WHERE order_id IN (
  SELECT id FROM public.square_orders WHERE invoice_id IS NOT NULL
);

-- 8. RLS: carry over any existing policies by renaming (Supabase mirrors RLS on renamed tables)
-- No explicit action needed — policies follow the table rename automatically in Postgres.

comment on table public.square_orders IS 'Square Orders (all sources). invoice_id populated for invoice-backed orders; NULL for POS.';
comment on table public.pos_line_items IS 'Line items for POS (taproom) Square orders only. Invoice-backed line items live in invoice_line_items.';
comment on column public.square_orders.invoice_id IS 'FK to invoices for orders that originated from a Square Invoice. NULL for POS orders.';

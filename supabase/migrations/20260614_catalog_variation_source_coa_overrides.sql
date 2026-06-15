-- Add per-source CoA override columns to square_catalog_variations.
-- These allow a single Square item to map to different GL accounts
-- depending on whether the transaction came through POS or an Invoice.
-- Resolution order: source-specific override → chart_of_accounts_id default → null.
ALTER TABLE public.square_catalog_variations
  ADD COLUMN IF NOT EXISTS chart_of_accounts_id_pos     uuid REFERENCES public.chart_of_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS chart_of_accounts_id_invoice uuid REFERENCES public.chart_of_accounts(id) ON DELETE SET NULL;

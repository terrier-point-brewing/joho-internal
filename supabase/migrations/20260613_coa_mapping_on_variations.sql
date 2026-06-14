-- Move CoA mapping to variation level
alter table public.square_catalog_variations
  add column if not exists chart_of_accounts_id uuid
    references public.chart_of_accounts(id) on delete set null;

-- Remove it from items (no longer needed there)
alter table public.square_catalog_items
  drop column if exists chart_of_accounts_id;

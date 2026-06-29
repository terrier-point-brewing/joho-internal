-- Add packaging_material service type for mapping packaging supply items to Square catalog.
-- Also fixes the service_type_check regression from 20260629 which dropped
-- distribution_discount / wholesale_discount (added by 20260627) when it re-added
-- the constraint with only the ingredient_deposit addition in scope.

alter table public.invoice_item_mappings
  drop constraint if exists invoice_item_mappings_service_type_check;

alter table public.invoice_item_mappings
  add constraint invoice_item_mappings_service_type_check
  check (service_type in (
    'packaging_fee', 'keg_cleaning', 'forklift', 'bulk_discount',
    'ingredient_deposit', 'distribution_discount', 'wholesale_discount',
    'packaging_material'
  ));

-- Update the row-level check to accommodate packaging_material (same constraints
-- as keg_cleaning / forklift) and distribution_discount / wholesale_discount
-- (same constraints as bulk_discount).
alter table public.invoice_item_mappings
  drop constraint if exists invoice_item_mappings_check;

alter table public.invoice_item_mappings
  add constraint invoice_item_mappings_check
  check (
    (service_type = 'packaging_fee' and packaging_item_id is not null
       and square_catalog_item_id is not null and square_catalog_variation_id is not null
       and square_catalog_discount_id is null)
    or
    (service_type in ('keg_cleaning', 'forklift', 'packaging_material') and packaging_item_id is null
       and square_catalog_item_id is not null and square_catalog_variation_id is not null
       and square_catalog_discount_id is null and packaging_format is null)
    or
    (service_type in ('bulk_discount', 'distribution_discount', 'wholesale_discount') and packaging_item_id is null
       and square_catalog_item_id is null and square_catalog_variation_id is null
       and square_catalog_discount_id is not null and packaging_format is null)
    or
    (service_type = 'ingredient_deposit' and packaging_item_id is null
       and square_catalog_item_id is not null and square_catalog_variation_id is not null
       and square_catalog_discount_id is null and packaging_format is null)
  );

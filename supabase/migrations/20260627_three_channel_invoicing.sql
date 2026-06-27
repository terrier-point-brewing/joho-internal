-- supabase/migrations/20260627_three_channel_invoicing.sql
-- Spec 9: Three-channel invoicing — add wholesale channel throughout,
-- add distribution_discount/wholesale_discount service types,
-- add packaging_format dimension to recipe_square_links for can format mappings.

-- 1. commitments.channel — add 'wholesale'
alter table public.commitments
  drop constraint if exists commitments_channel_check;
alter table public.commitments
  add constraint commitments_channel_check
  check (channel in ('distribution', 'contract_brewing', 'wholesale'));

-- 2. batch_allocations.channel — add 'wholesale'
alter table public.batch_allocations
  drop constraint if exists batch_allocations_channel_check;
alter table public.batch_allocations
  add constraint batch_allocations_channel_check
  check (channel in ('taproom', 'distribution', 'contract_brewing', 'wholesale', 'safety_stock'));

-- 3. export_transactions.channel — add 'wholesale'
alter table public.export_transactions
  drop constraint if exists export_transactions_channel_check;
alter table public.export_transactions
  add constraint export_transactions_channel_check
  check (channel in ('taproom', 'distribution', 'contract_brewing', 'wholesale'));

-- 4. invoice_item_mappings.service_type — add distribution_discount, wholesale_discount
alter table public.invoice_item_mappings
  drop constraint if exists invoice_item_mappings_service_type_check;
alter table public.invoice_item_mappings
  add constraint invoice_item_mappings_service_type_check
  check (service_type in (
    'packaging_fee', 'keg_cleaning', 'forklift',
    'bulk_discount', 'ingredient_deposit',
    'distribution_discount', 'wholesale_discount'
  ));

-- Also extend the cross-column shape check to cover new discount types
-- (they follow the same shape as bulk_discount: only discount_id populated,
-- and no packaging_format since discounts are not format-specific)
alter table public.invoice_item_mappings
  drop constraint if exists invoice_item_mappings_check;
alter table public.invoice_item_mappings
  add constraint invoice_item_mappings_check
  check (
    (service_type = 'packaging_fee' and packaging_item_id is not null
       and square_catalog_item_id is not null and square_catalog_variation_id is not null
       and square_catalog_discount_id is null)
    or
    (service_type in ('keg_cleaning', 'forklift') and packaging_item_id is null
       and square_catalog_item_id is not null and square_catalog_variation_id is not null
       and square_catalog_discount_id is null and packaging_format is null)
    or
    (service_type in ('bulk_discount', 'distribution_discount', 'wholesale_discount')
       and packaging_item_id is null
       and square_catalog_item_id is null and square_catalog_variation_id is null
       and square_catalog_discount_id is not null and packaging_format is null)
    or
    (service_type = 'ingredient_deposit' and packaging_item_id is null
       and square_catalog_item_id is not null and square_catalog_variation_id is not null
       and square_catalog_discount_id is null and packaging_format is null)
  );

-- 5. recipe_square_links — add packaging_format for can format dimension
alter table public.recipe_square_links
  add column if not exists packaging_format text
  check (packaging_format in ('loose', '4-pack', '6-pack', 'case'));

-- 6. Drop old can-link partial unique index (if it exists under any name)
drop index if exists recipe_square_links_recipe_packaging_item_unique;
drop index if exists rsl_item_uniq;

-- 7. Two new partial unique indexes
-- Kegs: format NULL, uniqueness is recipe + container
create unique index if not exists rsl_keg_uniq
  on public.recipe_square_links (recipe_id, packaging_item_id)
  where packaging_item_id is not null and packaging_format is null;

-- Cans: uniqueness is recipe + container + format
create unique index if not exists rsl_can_format_uniq
  on public.recipe_square_links (recipe_id, packaging_item_id, packaging_format)
  where packaging_item_id is not null and packaging_format is not null;

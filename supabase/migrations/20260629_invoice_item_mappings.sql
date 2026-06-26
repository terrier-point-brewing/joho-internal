-- supabase/migrations/20260629_invoice_item_mappings.sql
-- Spec 8: rename export_service_mappings -> invoice_item_mappings (no longer
-- export-specific once it covers deposits too), add the ingredient_deposit
-- service type, and add deposit-specific due-date settings.

alter table public.export_service_mappings rename to invoice_item_mappings;

alter index export_service_mappings_lookup_idx
  rename to invoice_item_mappings_lookup_idx;

alter table public.invoice_item_mappings
  drop constraint export_service_mappings_service_type_check;
alter table public.invoice_item_mappings
  add constraint invoice_item_mappings_service_type_check
  check (service_type in ('packaging_fee', 'keg_cleaning', 'forklift', 'bulk_discount', 'ingredient_deposit'));

alter table public.invoice_item_mappings
  drop constraint export_service_mappings_check;
alter table public.invoice_item_mappings
  add constraint invoice_item_mappings_check
  check (
    (service_type = 'packaging_fee' and packaging_item_id is not null
       and square_catalog_item_id is not null and square_catalog_variation_id is not null
       and square_catalog_discount_id is null)
    or
    (service_type in ('keg_cleaning', 'forklift') and packaging_item_id is null
       and square_catalog_item_id is not null and square_catalog_variation_id is not null
       and square_catalog_discount_id is null)
    or
    (service_type = 'bulk_discount' and packaging_item_id is null
       and square_catalog_item_id is null and square_catalog_variation_id is null
       and square_catalog_discount_id is not null)
    or
    (service_type = 'ingredient_deposit' and packaging_item_id is null
       and square_catalog_item_id is not null and square_catalog_variation_id is not null
       and square_catalog_discount_id is null)
  );

alter table public.contract_brewing_partners
  add column deposit_net_terms_days integer;

insert into public.system_settings (key, value)
values ('deposit_invoice_due_days', '30'::jsonb)
on conflict (key) do nothing;

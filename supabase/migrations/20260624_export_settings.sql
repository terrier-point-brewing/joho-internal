-- Spec 7: Export Settings + Barrel Excise Tax Settings
-- Adds Square Line Item mapping to excise_tax_rates, and a new
-- Customer/Packaging x Service -> Square Item mapping table.

alter table public.excise_tax_rates
  add column square_catalog_item_id text,
  add column square_catalog_variation_id text;

create table public.export_service_mappings (
  id                            uuid primary key default gen_random_uuid(),
  service_type                  text not null check (service_type in (
                                   'packaging_fee', 'keg_cleaning', 'forklift', 'bulk_discount'
                                 )),
  partner_id                    uuid references public.contract_brewing_partners(id) on delete cascade,
  packaging_item_id             uuid references public.packaging_items(id) on delete cascade,
  square_catalog_item_id        text,
  square_catalog_variation_id   text,
  square_catalog_discount_id    text,
  display_name                  text not null,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),
  unique nulls not distinct (service_type, partner_id, packaging_item_id),
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
  )
);

create index export_service_mappings_lookup_idx
  on public.export_service_mappings (service_type, partner_id, packaging_item_id);

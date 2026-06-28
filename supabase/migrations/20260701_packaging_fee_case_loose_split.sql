-- Packaging Fee needs separate Square mappings for "case" vs "loose can"
-- sales of the same can container, since Square invoicing rejects decimal
-- line item quantities and partial cases must be billed as whole cases +
-- loose cans. This adds the format dimension to invoice_item_mappings and
-- snapshots the format/units-per-package on export_transactions at write
-- time (packaging_variations rows can change later, so the transaction
-- needs its own durable record of what was actually shipped).

alter table public.export_transactions
  add column packaging_format text check (packaging_format in ('loose', '4-pack', '6-pack', 'case')),
  add column units_per_package numeric not null default 1;

alter table public.invoice_item_mappings
  add column packaging_format text check (packaging_format in ('case', 'loose'));

-- Drop the old single-row-per-item constraints before backfilling, since
-- the backfill intentionally creates a second (case) row per can item.
alter table public.invoice_item_mappings
  drop constraint invoice_item_mappings_check;
alter table public.invoice_item_mappings
  drop constraint export_service_mappings_service_type_partner_id_packaging_i_key;

-- Backfill existing can-type packaging_fee rows into both formats so
-- nothing breaks: the existing mapping becomes the "loose" default, and is
-- duplicated as the initial "case" mapping (admins can repoint case to a
-- different Square item afterward). Keg-type rows are untouched —
-- packaging_format stays null for them, since kegs have no case concept.
update public.invoice_item_mappings m
set packaging_format = 'loose'
where m.service_type = 'packaging_fee'
  and exists (
    select 1 from public.packaging_items p where p.id = m.packaging_item_id and p.type = 'can'
  );

insert into public.invoice_item_mappings
  (service_type, partner_id, packaging_item_id, square_catalog_item_id, square_catalog_variation_id, display_name, packaging_format)
select m.service_type, m.partner_id, m.packaging_item_id, m.square_catalog_item_id, m.square_catalog_variation_id, m.display_name, 'case'
from public.invoice_item_mappings m
where m.packaging_format = 'loose';

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
    (service_type = 'bulk_discount' and packaging_item_id is null
       and square_catalog_item_id is null and square_catalog_variation_id is null
       and square_catalog_discount_id is not null and packaging_format is null)
    or
    (service_type = 'ingredient_deposit' and packaging_item_id is null
       and square_catalog_item_id is not null and square_catalog_variation_id is not null
       and square_catalog_discount_id is null and packaging_format is null)
  );

-- Re-key the lookup so a (service_type, partner_id, packaging_item_id) pair
-- can have one row per format instead of exactly one row total. "nulls not
-- distinct" is preserved so every other service_type (where
-- packaging_format stays null) keeps behaving exactly as before.
alter table public.invoice_item_mappings
  add constraint invoice_item_mappings_lookup_key
  unique nulls not distinct (service_type, partner_id, packaging_item_id, packaging_format);

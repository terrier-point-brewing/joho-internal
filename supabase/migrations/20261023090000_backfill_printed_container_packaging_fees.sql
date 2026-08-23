-- ─── Packaging fees for partner-printed containers ───────────────────────────
--
-- Only the unprinted containers were ever mapped. Every partner-printed can and
-- keg had no invoice_item_mappings row at all, so an export invoice that used
-- one threw ("Packaging Fee (Case) is not configured for …") before it could
-- build a line — and the settings grid hid it, because a volume-class cell
-- showed whichever container in the class happened to be mapped.
--
-- The fee is a property of the SIZE, not the artwork: every mapping points at
-- one Square "Packaging Fee" item whose variations are 12oz Case, 16oz Case,
-- 1/6 Keg and so on. So a printed container bills exactly what its blank
-- counterpart bills, and this copies that across rather than inventing a price.
--
-- partner_id stays NULL. A printed container belongs to one partner by
-- definition, so there is nothing for a per-partner override to disambiguate,
-- and a NULL row is found however the shipment ends up billed — including
-- through a "Bill as" channel override, where the billed partner is not the
-- partner whose artwork is on the can.
--
-- NOT covered: 1/4 BBL Keg, blank or printed. Square has no 1/4 Keg variation
-- under the Packaging Fee item, so there is no price to copy. Someone has to
-- create it in Square and map it by hand.

insert into public.invoice_item_mappings (
  service_type, partner_id, packaging_item_id, packaging_format,
  square_catalog_item_id, square_catalog_variation_id, square_catalog_discount_id, display_name
)
select
  'packaging_fee',
  null,
  printed.id,
  blank_map.packaging_format,
  blank_map.square_catalog_item_id,
  blank_map.square_catalog_variation_id,
  null,
  blank_map.display_name
from public.packaging_items printed
join public.packaging_items blank
  on blank.partner_id is null
 and blank.type = printed.type
 and blank.volume_fl_oz = printed.volume_fl_oz
join public.invoice_item_mappings blank_map
  on blank_map.service_type = 'packaging_fee'
 and blank_map.partner_id is null
 and blank_map.packaging_item_id = blank.id
where printed.partner_id is not null
  and printed.type in ('can', 'keg')
  and printed.volume_fl_oz is not null
on conflict (service_type, partner_id, packaging_item_id, packaging_format)
  do nothing;

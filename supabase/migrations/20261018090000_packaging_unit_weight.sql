-- What one piece of packaging weighs, so freight stops being split by count.
--
-- Packaging has no unit AMBIGUITY to solve — every packaging_item is counted in
-- discrete pieces, and `each` is the only honest unit for a can, a lid, a
-- label, a keg or a paktech. So this is deliberately not the ingredient
-- vocabulary ported across; a dropdown with one option would buy nothing.
--
-- The defect is different. packaging_stock_adjustments' bulk receive hands
-- allocateFreightByWeight a line with no unit at all, so a shipment splits its
-- freight by piece count: receive 4,000 cans and 5,000 labels on one invoice
-- and the labels absorb 55% of the shipping despite weighing almost nothing.
-- That lands in unit_cost_usd and flows out into COGS.
--
-- This has never actually happened — no packaging receipt has ever carried a
-- shipping cost — so this is correctness by construction rather than a repair.

alter table public.packaging_items
  add column if not exists unit_weight_oz numeric
    check (unit_weight_oz is null or unit_weight_oz > 0);

comment on column public.packaging_items.unit_weight_oz is
  'Weight of ONE piece, in ounces — stock_quantity counts pieces for every type (can_count on paktechs and trays is capacity, not pack size). Used only to apportion freight across a receipt. NULL falls back to a count split, which the receive screen flags as an estimate.';

-- ── Seeded defaults ─────────────────────────────────────────────────────────
--
-- These are catalogue figures for standard components, not weighed samples.
-- They are close enough to divide a shipping bill fairly and are meant to be
-- corrected in the UI when someone puts a real pallet on a scale — which is why
-- the column is plain nullable numeric with no "is_estimated" flag: every value
-- here is an estimate, and pretending otherwise would be the lie.
--
--   can    12 oz body            ~13.0 g   = 0.46 oz
--   can    16 oz body            ~15.5 g   = 0.55 oz
--   lid    202 aluminium end      ~2.0 g   = 0.07 oz
--   label  pressure-sensitive     ~0.6 g   = 0.02 oz
--   paktech  per can slot         ~2.6 g   = 0.09 oz  (4-pack 0.37, 6-pack 0.55)
--   tray   24-can corrugated    ~119.0 g   = 4.20 oz
--   keg    1/6 bbl empty stainless  10.5 lb = 168 oz
--   keg    1/4 bbl empty stainless  22.0 lb = 352 oz
--   keg    1/2 bbl empty stainless  29.5 lb = 472 oz

update public.packaging_items
   set unit_weight_oz = case
     when type = 'can'   and volume_fl_oz = 12 then 0.46
     when type = 'can'   and volume_fl_oz = 16 then 0.55
     when type = 'can'                          then 0.55
     when type = 'lid'                          then 0.07
     when type = 'label'                        then 0.02
     when type = 'paktech' then round(coalesce(can_count, 4) * 0.092, 2)
     when type = 'tray'                         then 4.20
     when type = 'keg'   and volume_fl_oz >= 1900 then 472
     when type = 'keg'   and volume_fl_oz >=  900 then 352
     when type = 'keg'                            then 168
     else null
   end
 where unit_weight_oz is null;

-- Verify:
--   select type, name, volume_fl_oz, unit_weight_oz from packaging_items order by type, name;
--   select count(*) from packaging_items where unit_weight_oz is null;  -- expect 0

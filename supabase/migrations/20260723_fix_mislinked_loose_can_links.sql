-- Fix mis-mapped loose can-links (audited 2026-07-08).
--
-- Three recipes had their `loose` packaging-variation link pointed at the
-- "Regular - 16oz 4-Pack" *sale unit* instead of the base "Regular" variation
-- (the loose-can-tracked parent). Because Square derives the 4-Pack quantity as
-- base÷4, this both (a) rendered a fractional "loose" count in the old
-- Square-sourced inventory grid (e.g. "18.8 cans") and (b) left single-can sales
-- unattributed to cold storage (the base variation's only variation-grain link
-- was missing). Repoint each loose link to its base "Regular" variation.
--
-- Idempotent: each UPDATE is guarded by the current (wrong) square_variation_id,
-- so re-running after the fix is a no-op. Values captured from a read-only audit
-- of recipe_square_links vs square_catalog_variations on 2026-07-08.
--
-- ⚠️ Prod data change — apply manually after the standard backup, per repo policy.

-- Blackberry Lemon Wheat: loose "Regular - 16oz 4-Pack" -> "Regular"
update public.recipe_square_links
   set square_variation_id  = 'GJNWHL5EHBEI5GBVBV6LQC7W',
       catalog_variation_id = 'a1c1defa-de68-4d97-a0ff-90ec1f5a2453',
       variation_name       = 'Regular'
 where id = '8d6555d4-c2f7-458e-aaa4-3d977c6ffb5a'
   and square_variation_id = 'VJC2MCWOFOQNSRGQ5KTFF3GB';

-- Spring Bock: loose "Regular - 16oz 4-Pack" -> "Regular"
update public.recipe_square_links
   set square_variation_id  = '2EPGWGP4H3RPDM32NNITBED6',
       catalog_variation_id = '5e01cb0d-050b-465f-9997-f824611fa05c',
       variation_name       = 'Regular'
 where id = 'e6c72f72-0ebc-4e37-8b09-86955bbdcefb'
   and square_variation_id = 'ZVA6ZJAKQCKLJNAX2LTTLEAQ';

-- Vienna Lager: loose "16oz 4-Pack" -> "Regular"
update public.recipe_square_links
   set square_variation_id  = 'NG2MBCJCPLPI226K6USZQ3JP',
       catalog_variation_id = '734e2238-2403-452d-a53b-fe6b23bc7112',
       variation_name       = 'Regular'
 where id = '6a36f9ee-9e9a-4f49-bf80-60dd0b9916dc'
   and square_variation_id = 'X7WTRNQ6VPVBRULBCRKMNM3V';

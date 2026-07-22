-- Link the generic house kegs (1/2, 1/4, 1/6 Keg — keg containers with no
-- contract partner) to every existing recipe.
--
-- Context: the draft swap-keg dropdown (Taproom > Performance > Draft Stats)
-- lists only kegs explicitly linked to a tap's recipe via
-- recipe_packaging_variations. TPB's in-house draft beers drain these generic
-- house kegs, but the kegs had no recipe links — so the dropdown was blank.
-- Rather than special-casing generic kegs in the UI (which collapsed every
-- recipe's cold-storage kegs into one on-hand number), make them real per-recipe
-- links so on-hand resolves per (recipe, variation) like any other keg.
--
-- Idempotent: inserts only the (recipe, variation) pairs that don't already
-- exist, so re-running is a no-op.
insert into public.recipe_packaging_variations (recipe_id, variation_id)
select r.id, pv.id
  from public.recipes r
  cross join public.packaging_variations pv
  join public.packaging_items pi on pi.id = pv.container_id
 where pi.type = 'keg'
   and pv.partner_id is null
   and pv.is_active = true
   and not exists (
     select 1
       from public.recipe_packaging_variations rpv
      where rpv.recipe_id = r.id
        and rpv.variation_id = pv.id
   );

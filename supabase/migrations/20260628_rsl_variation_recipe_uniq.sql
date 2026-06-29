-- Generic packaging variations (partner_id IS NULL, e.g. "1/2 Keg") are shared
-- across all recipes. The old (variation_id) unique index allowed only ONE recipe
-- to ever link a generic variation, causing the grid to show ALL recipes as
-- "linked" when any one recipe accepted it (they all looked up the same variationId
-- key). Change to (variation_id, recipe_id) so each recipe can independently link
-- a generic variation to its own Square catalog item.

drop index if exists rsl_variation_uniq;

create unique index if not exists rsl_variation_recipe_uniq
  on public.recipe_square_links (variation_id, recipe_id)
  where variation_id is not null;

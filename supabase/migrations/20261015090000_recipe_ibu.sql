-- Recipes: IBU
--
-- Bitterness, like ABV, is a fact of the liquid rather than of any one batch —
-- so it lives on the recipe, alongside abv, and not on batches or on the
-- Square catalog item.
--
-- IBU is conventionally reported as a whole number; the scale runs 0 to ~120
-- in practice, so the check is a loose sanity bound rather than a style rule.

alter table public.recipes
  add column if not exists ibu integer
    check (ibu is null or (ibu >= 0 and ibu <= 200));

comment on column public.recipes.ibu is
  'International Bitterness Units — a fact of the liquid, owned by Production. Null when not measured.';

-- Verify:
--   select beer_name, abv, ibu from recipes limit 5;

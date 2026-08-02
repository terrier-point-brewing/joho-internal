-- Recipes learn the three facts a beer release needs from Production:
--
--   style        — the plain beer style ("Jasmine Peach Lager"). Until now the
--                  recipe NAME stood in for the style everywhere a "Style"
--                  column rendered (demand calendar, commitments, safety
--                  stock). Backfilled from beer_name — the stated best
--                  approximation — so nothing displays differently until
--                  someone edits a style on purpose. Two fields from here on:
--                  a recipe may be NAMED differently from the style that
--                  describes it.
--   abv          — a fact of the liquid, so it lives on the recipe next to
--                  yield and tank days. Brand reads it; brewing owns it.
--   product_code — a fact of the SELLABLE UNIT, not the liquid: a 4-pack and
--                  a keg of the same beer carry different codes. So it lives
--                  on the recipe↔packaging-variation link, the same level
--                  where Square catalog identity already attaches. Nullable
--                  everywhere; codes get filled in as they are assigned.
--
-- Human-gated (do not auto-apply).

alter table public.recipes
  add column if not exists style text,
  add column if not exists abv numeric(4,1)
    check (abv is null or (abv >= 0 and abv < 100));

update public.recipes set style = beer_name where style is null;

alter table public.recipe_packaging_variations
  add column if not exists product_code text;

-- Verification:
--   select beer_name, style, abv from recipes limit 5;
--   select column_name from information_schema.columns
--   where table_name = 'recipe_packaging_variations' and column_name = 'product_code';

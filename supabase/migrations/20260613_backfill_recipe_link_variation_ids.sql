create or replace function public.backfill_recipe_link_variation_ids()
returns void language sql security definer as $$
  update public.recipe_square_links rsl
  set catalog_variation_id = scv.id
  from public.square_catalog_variations scv
  where rsl.square_variation_id = scv.square_variation_id
    and rsl.catalog_variation_id is null;
$$;

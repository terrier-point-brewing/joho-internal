-- A batch's name is its recipe's name — step 2 of 2. Apply AFTER the code that
-- stops writing brew_batches.beer_name is deployed (step 1: 20261128090000).
--
-- The stored copy goes. `beer_name` stays selectable on brew_batches — in
-- selects, embeds and order() — as a PostgREST computed field that reads the
-- recipe, so there is one name and it cannot drift. Note `select("*")` does
-- NOT include a computed field; name it explicitly.

drop trigger if exists recipes_rename_mirrors_to_batches on public.recipes;
drop function if exists public.recipes_rename_mirrors_to_batches();
drop trigger if exists brew_batches_mirror_recipe_name on public.brew_batches;
drop function if exists public.brew_batches_mirror_recipe_name();

drop function if exists public.create_batch_with_consumption(text, date, date, numeric, integer, text, text, uuid);

drop view if exists public.batch_exhaustion;

alter table public.brew_batches drop column beer_name;

create function public.beer_name(public.brew_batches)
returns text language sql stable set search_path = public as $$
  select r.beer_name from public.recipes r where r.id = $1.recipe_id
$$;

create view public.batch_exhaustion with (security_invoker = true) as
 SELECT b.id AS batch_id,
    b.batch_number,
    r.beer_name,
    b.status,
    b.volume_bbl AS original_volume_bbl,
    COALESCE(sum(t.volume_bbl) FILTER (WHERE (t.transfer_type = 'kegging'::text)), (0)::numeric) AS kegged_bbl,
    COALESCE(sum(t.volume_bbl) FILTER (WHERE (t.transfer_type = 'canning'::text)), (0)::numeric) AS canned_bbl,
    COALESCE(sum(t.volume_bbl) FILTER (WHERE ((eq_to.type = ANY (ARRAY['export_bay'::text, 'loading_bay'::text])) AND (t.to_batch_id IS NULL))), (0)::numeric) AS exported_bbl,
    COALESCE(sum(t.volume_bbl) FILTER (WHERE (t.to_batch_id IS NOT NULL)), (0)::numeric) AS converted_bbl,
    COALESCE(sum(t.shrinkage_bbl), (0)::numeric) AS shrinkage_bbl,
    ((((COALESCE(sum(t.volume_bbl) FILTER (WHERE (t.transfer_type = 'kegging'::text)), (0)::numeric) + COALESCE(sum(t.volume_bbl) FILTER (WHERE (t.transfer_type = 'canning'::text)), (0)::numeric)) + COALESCE(sum(t.volume_bbl) FILTER (WHERE ((eq_to.type = ANY (ARRAY['export_bay'::text, 'loading_bay'::text])) AND (t.to_batch_id IS NULL))), (0)::numeric)) + COALESCE(sum(t.volume_bbl) FILTER (WHERE (t.to_batch_id IS NOT NULL)), (0)::numeric)) + COALESCE(sum(t.shrinkage_bbl), (0)::numeric)) AS consumed_bbl,
    (b.volume_bbl - ((((COALESCE(sum(t.volume_bbl) FILTER (WHERE (t.transfer_type = 'kegging'::text)), (0)::numeric) + COALESCE(sum(t.volume_bbl) FILTER (WHERE (t.transfer_type = 'canning'::text)), (0)::numeric)) + COALESCE(sum(t.volume_bbl) FILTER (WHERE ((eq_to.type = ANY (ARRAY['export_bay'::text, 'loading_bay'::text])) AND (t.to_batch_id IS NULL))), (0)::numeric)) + COALESCE(sum(t.volume_bbl) FILTER (WHERE (t.to_batch_id IS NOT NULL)), (0)::numeric)) + COALESCE(sum(t.shrinkage_bbl), (0)::numeric))) AS remaining_bbl,
    ((b.volume_bbl - ((((COALESCE(sum(t.volume_bbl) FILTER (WHERE (t.transfer_type = 'kegging'::text)), (0)::numeric) + COALESCE(sum(t.volume_bbl) FILTER (WHERE (t.transfer_type = 'canning'::text)), (0)::numeric)) + COALESCE(sum(t.volume_bbl) FILTER (WHERE ((eq_to.type = ANY (ARRAY['export_bay'::text, 'loading_bay'::text])) AND (t.to_batch_id IS NULL))), (0)::numeric)) + COALESCE(sum(t.volume_bbl) FILTER (WHERE (t.to_batch_id IS NOT NULL)), (0)::numeric)) + COALESCE(sum(t.shrinkage_bbl), (0)::numeric))) <= 0.001) AS is_exhausted
   FROM brew_batches b
     JOIN recipes r ON r.id = b.recipe_id
     LEFT JOIN batch_transfers t ON t.batch_id = b.id
     LEFT JOIN equipment eq_to ON eq_to.id = t.to_tank_id
  GROUP BY b.id, b.batch_number, r.beer_name, b.status, b.volume_bbl;

notify pgrst, 'reload schema';

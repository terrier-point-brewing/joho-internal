-- A batch's name is its recipe's name — step 1 of 2 (safe before the deploy).
--
-- brew_batches.beer_name was a hand-typed copy of recipes.beer_name. Nothing
-- kept the two in sync, and 6 of 41 batches had drifted (B-027, B-035, B-039,
-- B-047, B-050, B-060). Step 2 (20261128090100) drops the column and serves
-- `beer_name` as a computed field over the recipe. This step keeps the column
-- alive but makes it a mirror, so the code that still writes it (pre-deploy)
-- and the code that no longer does (post-deploy) both work.

-- Every batch has a recipe (41/41); the name now depends on it.
alter table public.brew_batches alter column recipe_id set not null;

-- Nullable, so new code can stop sending it; the trigger fills it anyway.
alter table public.brew_batches alter column beer_name drop not null;

create or replace function public.brew_batches_mirror_recipe_name()
returns trigger language plpgsql set search_path = public as $$
begin
  new.beer_name := (select r.beer_name from public.recipes r where r.id = new.recipe_id);
  return new;
end;
$$;

drop trigger if exists brew_batches_mirror_recipe_name on public.brew_batches;
create trigger brew_batches_mirror_recipe_name
  before insert or update of beer_name, recipe_id on public.brew_batches
  for each row execute function public.brew_batches_mirror_recipe_name();

create or replace function public.recipes_rename_mirrors_to_batches()
returns trigger language plpgsql set search_path = public as $$
begin
  update public.brew_batches set beer_name = new.beer_name where recipe_id = new.id;
  return null;
end;
$$;

drop trigger if exists recipes_rename_mirrors_to_batches on public.recipes;
create trigger recipes_rename_mirrors_to_batches
  after update of beer_name on public.recipes
  for each row when (old.beer_name is distinct from new.beer_name)
  execute function public.recipes_rename_mirrors_to_batches();

-- Repair the six drifted names.
update public.brew_batches b
   set beer_name = r.beer_name
  from public.recipes r
 where r.id = b.recipe_id
   and b.beer_name is distinct from r.beer_name;

-- The batch factory without a name argument. PostgREST picks the overload by
-- argument names, so the old 8-arg version keeps serving pre-deploy code until
-- step 2 drops it.
create or replace function public.create_batch_with_consumption(
  p_planned_brew_date date, p_expected_delivery_date date, p_volume_bbl numeric,
  p_turns integer, p_status text, p_notes text, p_recipe_id uuid
) returns public.brew_batches
language plpgsql set search_path = public as $$
DECLARE
  v_batch public.brew_batches;
BEGIN
  INSERT INTO public.brew_batches(
    planned_brew_date, expected_delivery_date,
    volume_bbl, turns, status, notes, recipe_id
  ) VALUES (
    p_planned_brew_date, p_expected_delivery_date,
    p_volume_bbl, COALESCE(p_turns, 1), COALESCE(p_status, 'planning'), p_notes, p_recipe_id
  ) RETURNING * INTO v_batch;

  INSERT INTO public.batch_status_history(batch_id, status, note)
    VALUES (v_batch.id, v_batch.status, 'Batch created');

  -- Ingredient deduction happens at turn start (brewhouse assignment), not here.

  RETURN v_batch;
END;
$$;

notify pgrst, 'reload schema';

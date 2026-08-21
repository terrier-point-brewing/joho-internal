-- ─── recipes.base_recipe_id: a derived recipe declares the beer it converts from ──
--
-- Some beers are only ever made by converting another: Orange Pilsner is Pace
-- Yourself Pilsner plus oranges, Reaper's Harvest is Carolina Brown Ale plus
-- pumpkin puree. Cloning already copies the bill, but the copy lands as an
-- unrelated recipe, so nothing downstream can tell the base apart from the
-- addition. That leaves a conversion with two wrong choices: commit the whole
-- bill (reserving grain that already went into the parent batch) or commit
-- nothing (which is why Orange Pilsner and Blackberry Lemon Wheat carry no
-- ingredient lines at all).
--
-- The link makes the split computable. It deliberately does NOT change what
-- recipe_ingredients means: a derived recipe still holds its COMPLETE bill, so
-- every existing reader — costing, commitments, deposit reconstruction,
-- inventory-on-hand — stays correct, and brewing the beer from scratch still
-- charges the full bill. Only a conversion consults the base, and it charges
-- the difference.
--
-- Breaking the link is therefore a pure metadata change: null the column and the
-- recipe is a standalone original again, bill intact.

alter table public.recipes
  add column if not exists base_recipe_id uuid references public.recipes(id) on delete set null;

comment on column public.recipes.base_recipe_id is
  'The recipe this one is a conversion of. The bill here is still COMPLETE (base + additions); a conversion commits only the per-bbl difference against the base. NULL = a standalone original.';

-- A recipe cannot be derived from itself.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'recipes_base_recipe_id_not_self'
  ) then
    alter table public.recipes
      add constraint recipes_base_recipe_id_not_self
      check (base_recipe_id is distinct from id);
  end if;
end;
$$;

create index if not exists idx_recipes_base_recipe_id
  on public.recipes(base_recipe_id)
  where base_recipe_id is not null;

-- ─── One level only ───────────────────────────────────────────────────────────
-- Lineage is base → derived and stops there. A chain (A → B → C) would make
-- "the difference against the base" ambiguous — C's conversion would have to
-- know whether it is being drawn off B or off A — and a cycle would hang any
-- reader that walked it. Two rules keep the shape flat and acyclic:
--   • a derived recipe's base must itself be an original, and
--   • a recipe that other recipes derive from cannot become derived.

create or replace function public.recipes_enforce_flat_lineage()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.base_recipe_id is null then
    return new;
  end if;

  if exists (
    select 1 from public.recipes
    where id = new.base_recipe_id and base_recipe_id is not null
  ) then
    raise exception
      'Cannot base a recipe on % — that recipe is itself derived from another. Link to the original instead.',
      (select beer_name from public.recipes where id = new.base_recipe_id);
  end if;

  if exists (
    select 1 from public.recipes
    where base_recipe_id = new.id
  ) then
    raise exception
      'Cannot make % derived — other recipes are already based on it. Break those links first.',
      new.beer_name;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_recipes_flat_lineage on public.recipes;
create trigger trg_recipes_flat_lineage
  before insert or update of base_recipe_id on public.recipes
  for each row execute function public.recipes_enforce_flat_lineage();

-- ─── Backfill the links the conversion history already proves ─────────────────
-- Every executed conversion is direct evidence that the target's recipe is made
-- from the source's. Only pairs where the two recipes genuinely differ, and
-- where neither side is already part of a link, are set — the trigger above
-- would reject anything that formed a chain.

update public.recipes r
   set base_recipe_id = src.recipe_id
  from (
    -- Only an unambiguous history counts: a target fed by two different base
    -- recipes has no single answer, so it is left for a human to declare.
    select tb.recipe_id as target_recipe_id, min(sb.recipe_id::text)::uuid as recipe_id
      from batch_conversions bc
      join brew_batches sb on sb.id = bc.source_batch_id
      join brew_batches tb on tb.id = bc.target_batch_id
     where sb.recipe_id is not null
       and tb.recipe_id is not null
       and sb.recipe_id <> tb.recipe_id
     group by tb.recipe_id
    having count(distinct sb.recipe_id) = 1
  ) src
 where r.id = src.target_recipe_id
   and r.base_recipe_id is null
   -- Skip a target that is itself a base for something else, and a source that
   -- is itself derived: either would be a chain.
   and not exists (select 1 from public.recipes o where o.base_recipe_id = r.id)
   and not exists (select 1 from public.recipes b where b.id = src.recipe_id and b.base_recipe_id is not null);

-- Recipe ingredient quantities are entered per BREW TURN, but only the per-BBL
-- rate was ever stored. Every save divided the entered number by the recipe's
-- expected yield and every read multiplied it back, so a value like 55 lb over a
-- 7.75 bbl turn drifted a little each round trip.
--
-- Make quantity_per_turn the stored source of truth and derive quantity_per_bbl
-- from it. The derived column stays in place — commitments, deposit invoices,
-- tank assignments and Square invoicing all read the per-BBL rate — but it is
-- now maintained by trigger rather than by the app.

-- Prod carried quantity_per_bbl as numeric(10,4), which is where most of the
-- drift actually came from: 165 lb / 19.5 bbl stored as 8.4615 reads back as
-- 164.99925. Widen it so the derived rate stays faithful for everything that
-- multiplies it by a batch volume.
alter table public.recipe_ingredients
  alter column quantity_per_bbl type numeric(18,10);

alter table public.recipe_ingredients
  add column if not exists quantity_per_turn numeric;

-- Backfill from the rate that was stored, using the same fallback the UI used
-- when a recipe has no expected yield (treat the turn as 1 bbl).
update public.recipe_ingredients ri
   set quantity_per_turn = ri.quantity_per_bbl * coalesce(nullif(r.expected_yield_bbl, 0), 1)
  from public.recipes r
 where r.id = ri.recipe_id
   and ri.quantity_per_turn is null;

-- Orphan safety: rows whose recipe somehow didn't join.
update public.recipe_ingredients
   set quantity_per_turn = quantity_per_bbl
 where quantity_per_turn is null;

-- Repair the drift the old 4-decimal rate baked in: 3.2994 lb of CTZ was 3.3,
-- 109.9995 lb of Munich was 110. Only snap where the reconstructed value is
-- within 0.1% of a 2-decimal number, so genuinely fine-grained entries (e.g.
-- 3.126 lb) are left exactly as they are.
update public.recipe_ingredients
   set quantity_per_turn = round(quantity_per_turn::numeric, 2)
 where quantity_per_turn <> round(quantity_per_turn::numeric, 2)
   and abs(quantity_per_turn - round(quantity_per_turn::numeric, 2))
       <= 0.001 * abs(quantity_per_turn);

alter table public.recipe_ingredients
  alter column quantity_per_turn set not null;

-- Derive the per-BBL rate whenever a line's turn quantity (or its recipe) changes.
create or replace function public.recipe_ingredient_sync_per_bbl()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  yield numeric;
begin
  select coalesce(nullif(r.expected_yield_bbl, 0), 1)
    into yield
    from public.recipes r
   where r.id = new.recipe_id;

  new.quantity_per_bbl := new.quantity_per_turn / coalesce(yield, 1);
  return new;
end;
$$;

drop trigger if exists recipe_ingredients_sync_per_bbl on public.recipe_ingredients;
create trigger recipe_ingredients_sync_per_bbl
  before insert or update of quantity_per_turn, recipe_id
  on public.recipe_ingredients
  for each row
  execute function public.recipe_ingredient_sync_per_bbl();

-- Changing a recipe's expected yield changes the RATE, not the turn quantity:
-- the brewer still charges the same 55 lb into a bigger or smaller turn.
create or replace function public.recipes_resync_ingredient_rates()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.recipe_ingredients ri
     set quantity_per_bbl = ri.quantity_per_turn
                            / coalesce(nullif(new.expected_yield_bbl, 0), 1)
   where ri.recipe_id = new.id;
  return new;
end;
$$;

drop trigger if exists recipes_resync_ingredient_rates on public.recipes;
create trigger recipes_resync_ingredient_rates
  after update of expected_yield_bbl
  on public.recipes
  for each row
  when (new.expected_yield_bbl is distinct from old.expected_yield_bbl)
  execute function public.recipes_resync_ingredient_rates();

comment on column public.recipe_ingredients.quantity_per_turn is
  'Ingredient quantity charged into one brew turn, exactly as entered. Source of truth.';
comment on column public.recipe_ingredients.quantity_per_bbl is
  'Derived: quantity_per_turn / recipes.expected_yield_bbl. Maintained by trigger — never write directly.';

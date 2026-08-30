-- ─── Two conversions the brewhouse does that the books could not express ──────
--
-- 1. A DOUBLE CONVERSION. Pace Yourself Pilsner becomes Carolina Mule (ginger,
--    lime), and Carolina Mule becomes Transfusion Lager (grape juice). Lineage
--    was capped at one level, so only one of those two links could exist — and
--    since Transfusion already named Mule as its base, Mule could never name the
--    Pilsner as its own. Converting Pilsner → Mule therefore charged nothing.
--
--    The cap was defensive, not necessary. "What does the conversion add?" is
--    answered against the recipe of the batch actually being drawn off, and
--    since every bill is COMPLETE and every conversion only adds, the chain
--    composes: Mule − Pilsner = ginger + lime, Transfusion − Mule = grape juice,
--    Transfusion − Pilsner = all three. Nothing is ambiguous; a chain just needs
--    to be acyclic.
--
-- 2. AN IN-KEG CONVERSION. Sometimes the dose goes into each keg as it is
--    filled: the tank holds Carolina Mule, the kegs hold Transfusion Lager, and
--    no separate batch ever exists. `batch_transfers.packaged_as_recipe_id`
--    lets one kegging run say what actually came out of the filler.

-- ─── 1. Lineage may chain; it may not loop ────────────────────────────────────

drop trigger if exists trg_recipes_flat_lineage on public.recipes;
drop function if exists public.recipes_enforce_flat_lineage();

create or replace function public.recipes_enforce_acyclic_lineage()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  cursor_id uuid;
  hops int := 0;
begin
  if new.base_recipe_id is null then
    return new;
  end if;

  -- Walk up from the proposed base. Reaching this recipe again closes a cycle,
  -- which would hang every reader that follows the chain.
  cursor_id := new.base_recipe_id;
  while cursor_id is not null and hops < 20 loop
    if cursor_id = new.id then
      raise exception
        'Cannot base % on % — % already converts from % further up the chain.',
        new.beer_name,
        (select beer_name from public.recipes where id = new.base_recipe_id),
        (select beer_name from public.recipes where id = new.base_recipe_id),
        new.beer_name;
    end if;
    select base_recipe_id into cursor_id from public.recipes where id = cursor_id;
    hops := hops + 1;
  end loop;

  if hops >= 20 then
    raise exception 'Recipe lineage is too deep (more than 20 conversions). Break a link first.';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_recipes_acyclic_lineage on public.recipes;
create trigger trg_recipes_acyclic_lineage
  before insert or update of base_recipe_id on public.recipes
  for each row execute function public.recipes_enforce_acyclic_lineage();

comment on function public.recipes_enforce_acyclic_lineage() is
  'Guards recipes.base_recipe_id against cycles and runaway depth. Chains ARE allowed: a conversion measures against the recipe of the batch it is drawn off, so Pilsner → Mule → Transfusion needs no special case.';

comment on column public.recipes.base_recipe_id is
  'The recipe this one is normally made by converting. The bill here is still COMPLETE (base + additions); a conversion commits only the per-bbl difference against the recipe of the batch actually drawn off, which may be any ancestor in the chain. NULL = a standalone original.';

-- ─── 2. A packaging run can declare the beer it produced ──────────────────────
-- Set only when the run converted in the container. NULL — the overwhelming
-- majority — means the run packaged its own batch's recipe, exactly as before.

alter table public.batch_transfers
  add column if not exists packaged_as_recipe_id uuid references public.recipes(id);

comment on column public.batch_transfers.packaged_as_recipe_id is
  'For an in-keg/in-can conversion: the recipe this packaging run actually produced, which must be derived (at any depth) from the batch''s own recipe. The finished goods land under THIS recipe and the conversion''s addition is charged against the source batch. NULL = the run packaged the batch''s own recipe.';

create index if not exists idx_batch_transfers_packaged_as_recipe_id
  on public.batch_transfers(packaged_as_recipe_id)
  where packaged_as_recipe_id is not null;

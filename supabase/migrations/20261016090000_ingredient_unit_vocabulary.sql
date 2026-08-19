-- Ingredient units: a row you pick, not a string you type.
--
-- `ingredients.unit` was free text. Prod happens to be clean — four values
-- across 68 rows — but nothing held it there, and nothing held the NUMBERS to
-- it either: `update ingredients set unit = 'oz'` left stock_quantity,
-- cost_per_unit_usd, every recipe line and every open commitment carrying
-- numbers that now meant a sixteenth of what they had a moment before.
--
-- Two things change here, and only for ingredients. Packaging and produced
-- inventory carry their own unit semantics (square_catalog_variations'
-- inventory_unit, volume_fl_oz_per_unit, the fl-oz volume ledger) and are
-- deliberately untouched.
--
--   1. A vocabulary table the column points at, so the set is closed.
--   2. A trigger that refuses a direct unit edit once the ingredient has
--      anything riding on it, plus convert_ingredient_unit() — the one path
--      that changes a unit, moving every dependent number with it in a single
--      transaction.

-- ── 1. The vocabulary ───────────────────────────────────────────────────────
--
-- base_factor is expressed in that dimension's base unit: ounces for weight,
-- fluid ounces for volume, one-per-one for count. It is NULL when a unit has
-- no fixed factor — a yeast brick is a count of a thing whose weight is a
-- property of the product, not of the unit. NULL means "do not convert", not
-- "convert as 1".
--
-- The weight numbers here are the same physical constants
-- lib/production/units.ts carries for freight allocation; that module is a
-- superset (it also matches typed-in aliases like "pound" and "#" that are not
-- and should not be part of this vocabulary).
create table if not exists public.ingredient_units (
  code        text primary key,
  label       text not null,
  dimension   text not null check (dimension in ('weight', 'volume', 'count')),
  base_factor numeric check (base_factor is null or base_factor > 0),
  is_active   boolean not null default true,
  sort_order  integer not null default 0,
  created_at  timestamp with time zone not null default now(),
  updated_at  timestamp with time zone
);

comment on table public.ingredient_units is
  'Closed vocabulary for ingredients.unit. Seeded by migration — the app reads it, never writes it.';
comment on column public.ingredient_units.base_factor is
  'Units of the dimension base (oz for weight, fl oz for volume) in one of this unit. NULL = no fixed conversion.';

insert into public.ingredient_units (code, label, dimension, base_factor, sort_order) values
  ('lbs',    'lbs',    'weight',  16,      10),
  ('oz',     'oz',     'weight',   1,      20),
  ('liters', 'liters', 'volume',  33.814,  30),
  ('each',   'each',   'count',    1,      40),
  ('bricks', 'bricks', 'count',    null,   50)
on conflict (code) do nothing;

alter table public.ingredient_units enable row level security;

-- Read-only to the app: this is a declared vocabulary, extended by migration.
drop policy if exists "authenticated read" on public.ingredient_units;
create policy "authenticated read" on public.ingredient_units
  for select to authenticated using (true);

drop trigger if exists update_ingredient_units_updated_at on public.ingredient_units;
create trigger update_ingredient_units_updated_at
  before insert or update on public.ingredient_units
  for each row execute function public.update_updated_at();

-- ── 2. Point the column at it ───────────────────────────────────────────────
--
-- Normalize first. Prod is already exactly these five codes, so this is a
-- no-op today and a safety net for anything that landed between writing this
-- and applying it.
update public.ingredients
   set unit = lower(btrim(unit))
 where unit <> lower(btrim(unit));

update public.ingredients set unit = 'lbs'    where unit in ('lb', 'pound', 'pounds', '#');
update public.ingredients set unit = 'oz'     where unit in ('ounce', 'ounces');
update public.ingredients set unit = 'liters' where unit in ('l', 'liter', 'litre', 'litres');
update public.ingredients set unit = 'each'   where unit in ('ea', 'unit', 'units');
update public.ingredients set unit = 'bricks' where unit in ('brick');

-- Anything still unrecognized joins the vocabulary rather than blocking the
-- migration: an unknown unit is a real measurement someone is using, and
-- dropping it on the floor would silently rewrite their stock figures. It
-- lands inactive so the dropdown stops offering it going forward.
insert into public.ingredient_units (code, label, dimension, base_factor, is_active, sort_order)
select distinct i.unit, i.unit, 'count', null::numeric, false, 900
  from public.ingredients i
 where not exists (select 1 from public.ingredient_units u where u.code = i.unit)
on conflict (code) do nothing;

alter table public.ingredients
  drop constraint if exists ingredients_unit_fkey;
alter table public.ingredients
  add constraint ingredients_unit_fkey
  foreign key (unit) references public.ingredient_units (code)
  on update cascade on delete restrict;

comment on column public.ingredients.unit is
  'FK to ingredient_units.code. Never edited in place once the ingredient is in use — see convert_ingredient_unit().';

-- The snapshot columns (stock_adjustments.unit, deposit_invoice_ingredients.unit)
-- deliberately get NO foreign key. They record what the unit WAS when the row
-- was written; a conversion must not reach back and restate history, and
-- retiring a code must not orphan it.

-- ── 3. The gate ─────────────────────────────────────────────────────────────
--
-- A unit edit is allowed only while the ingredient has nothing riding on it:
-- zero stock, and no recipe line, commitment, stock adjustment or deposit
-- invoice line referring to it. That is a typo correction. Once any of those
-- exist the number has a meaning, and changing the unit under it is a
-- conversion — which is what convert_ingredient_unit() is for.
create or replace function public.ingredient_has_dependents(p_ingredient_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select stock_quantity <> 0 from public.ingredients where id = p_ingredient_id), false)
      or exists (select 1 from public.recipe_ingredients          where ingredient_id = p_ingredient_id)
      or exists (select 1 from public.batch_ingredient_commitments where ingredient_id = p_ingredient_id)
      or exists (select 1 from public.stock_adjustments            where ingredient_id = p_ingredient_id)
      or exists (select 1 from public.deposit_invoice_ingredients  where ingredient_id = p_ingredient_id);
$$;

create or replace function public.ingredients_guard_unit_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.unit is not distinct from old.unit then
    return new;
  end if;

  -- convert_ingredient_unit() announces itself for the row it is converting.
  -- set_config(..., true) is transaction-local, so this cannot leak past it.
  if coalesce(current_setting('app.ingredient_unit_conversion', true), '') = old.id::text then
    return new;
  end if;

  if public.ingredient_has_dependents(old.id) then
    raise exception
      'Cannot change % from % to % directly — stock, recipes or history depend on that unit. Use convert_ingredient_unit() so every quantity moves with it.',
      old.name, old.unit, new.unit
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists ingredients_guard_unit_change on public.ingredients;
create trigger ingredients_guard_unit_change
  before update of unit on public.ingredients
  for each row execute function public.ingredients_guard_unit_change();

-- ── 4. The one path that changes a unit ─────────────────────────────────────
--
-- Everything the ratio touches moves in one transaction: stock on hand, the
-- per-unit cost (which moves the other way), every recipe line's
-- quantity_per_turn, and every OPEN commitment. quantity_per_bbl re-derives
-- itself through recipe_ingredients_sync_per_bbl.
--
-- Released commitments and the two snapshot tables are left exactly as they
-- are. They are history: 55 lbs was charged into B-058 and no later
-- bookkeeping decision changes what went into the kettle.
create or replace function public.convert_ingredient_unit(
  p_ingredient_id uuid,
  p_to_unit       text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name          text;
  v_from          text;
  v_from_dim      text;
  v_from_factor   numeric;
  v_to_dim        text;
  v_to_factor     numeric;
  v_to_active     boolean;
  v_ratio         numeric;
  v_recipes       integer;
  v_commitments   integer;
  v_new_stock     numeric;
  v_new_cost      numeric;
begin
  select name, unit into v_name, v_from
    from public.ingredients where id = p_ingredient_id for update;
  if not found then
    raise exception 'Ingredient % not found', p_ingredient_id using errcode = 'P0002';
  end if;

  if v_from = p_to_unit then
    raise exception '% is already measured in %', v_name, p_to_unit using errcode = '22023';
  end if;

  select dimension, base_factor into v_from_dim, v_from_factor
    from public.ingredient_units where code = v_from;
  select dimension, base_factor, is_active into v_to_dim, v_to_factor, v_to_active
    from public.ingredient_units where code = p_to_unit;

  if v_to_dim is null then
    raise exception 'Unknown unit "%"', p_to_unit using errcode = '22023';
  end if;
  if not v_to_active then
    raise exception '"%" is retired and cannot be converted to', p_to_unit using errcode = '22023';
  end if;
  if v_from_dim is distinct from v_to_dim then
    raise exception
      'Cannot convert % from % (%) to % (%) — those measure different things, so there is no honest ratio.',
      v_name, v_from, v_from_dim, p_to_unit, v_to_dim
      using errcode = '22023';
  end if;
  if v_from_factor is null or v_to_factor is null then
    raise exception 'No fixed conversion exists between % and %', v_from, p_to_unit
      using errcode = '22023';
  end if;

  -- Quantities scale by the ratio; a per-unit cost scales by its inverse, so
  -- the extended value (qty x cost) is unchanged. That is the whole invariant:
  -- a conversion restates the numbers, it never moves value.
  v_ratio := v_from_factor / v_to_factor;

  perform set_config('app.ingredient_unit_conversion', p_ingredient_id::text, true);

  update public.ingredients
     set unit              = p_to_unit,
         stock_quantity    = stock_quantity * v_ratio,
         cost_per_unit_usd = case when cost_per_unit_usd is null then null
                                  else cost_per_unit_usd / v_ratio end
   where id = p_ingredient_id
  returning stock_quantity, cost_per_unit_usd into v_new_stock, v_new_cost;

  update public.recipe_ingredients
     set quantity_per_turn = quantity_per_turn * v_ratio
   where ingredient_id = p_ingredient_id;
  get diagnostics v_recipes = row_count;

  update public.batch_ingredient_commitments
     set committed_qty = committed_qty * v_ratio
   where ingredient_id = p_ingredient_id
     and released_at is null;
  get diagnostics v_commitments = row_count;

  return jsonb_build_object(
    'ingredient_id',       p_ingredient_id,
    'name',                v_name,
    'from_unit',           v_from,
    'to_unit',             p_to_unit,
    'ratio',               v_ratio,
    'stock_quantity',      v_new_stock,
    'cost_per_unit_usd',   v_new_cost,
    'recipe_lines',        v_recipes,
    'open_commitments',    v_commitments
  );
end;
$$;

revoke all on function public.convert_ingredient_unit(uuid, text) from public;
grant execute on function public.convert_ingredient_unit(uuid, text) to authenticated;

comment on function public.convert_ingredient_unit(uuid, text) is
  'The only way ingredients.unit changes once the ingredient is in use. Rescales stock, cost, recipe lines and open commitments atomically; leaves history alone.';

-- Verify:
--   select * from ingredient_units order by sort_order;
--   select name, unit, stock_quantity from ingredients order by name limit 5;
--   -- should raise 42501:
--   update ingredients set unit = 'oz' where unit = 'lbs' and stock_quantity > 0;

-- IBU: one value of record, two ways to arrive at it.
--
-- `recipes.ibu` already exists and 12 of 24 recipes carry a hand-typed number.
-- That column stays exactly what it is — the bitterness of the beer, read by
-- anything that needs it. Nothing here derives it behind an operator's back.
--
-- What this adds is a declared SOURCE. A recipe whose bill carries alpha acids
-- and boil times can have its IBU computed from that bill; every other recipe
-- keeps a typed number, and that is the default. The inputs a computation needs
-- are nowhere in this database today (0 of 19 hops have an alpha acid,
-- brew_activities is empty), so 'manual' is not a fallback here — it is the
-- normal case, and backfilling typed IBUs must never be blocked on data
-- collection that has not started.

alter table public.recipes
  add column if not exists ibu_source text not null default 'manual'
    check (ibu_source in ('manual', 'calculated'));

comment on column public.recipes.ibu_source is
  'Where recipes.ibu comes from: ''manual'' (typed, the default and current normal case) or ''calculated'' (derived from the ingredient bill). The value itself always lives in recipes.ibu.';

comment on column public.recipes.ibu is
  'International Bitterness Units — the value of record regardless of ibu_source. Null when not yet known.';

-- ── The inputs a calculation needs ──────────────────────────────────────────
--
-- Both are nullable and both stay empty until someone fills them in. They exist
-- so a recipe CAN be switched to 'calculated' once its bill is complete, not so
-- that anything starts depending on them.

-- Tinseth needs a boil time per hop addition. It is not defaultable: the same
-- ounce of Citra gives roughly ten times the bitterness at 60 minutes that it
-- does in a whirlpool, so a missing time makes an IBU wrong rather than rough.
alter table public.recipe_ingredients
  add column if not exists boil_minutes integer
    check (boil_minutes is null or (boil_minutes >= 0 and boil_minutes <= 240));

comment on column public.recipe_ingredients.boil_minutes is
  'Minutes in the boil for a hop addition. NULL on non-hop lines and on hop lines nobody has timed yet. Required before a recipe can use ibu_source = ''calculated''.';

-- Tinseth's bigness factor falls with wort density, so an imperial stout and a
-- session lager extract different bitterness from identical hops. Batches
-- already record their measured OG; this is the recipe's target.
alter table public.recipes
  add column if not exists original_gravity numeric(6,3)
    check (original_gravity is null or (original_gravity >= 1 and original_gravity <= 1.2));

comment on column public.recipes.original_gravity is
  'Target original gravity (e.g. 1.052). Feeds the Tinseth bigness factor. NULL until measured; brew_batches.original_gravity is the per-batch actual.';

-- Verify:
--   select beer_name, ibu, ibu_source, original_gravity from recipes order by beer_name;
--   select count(*) from recipes where ibu is null;   -- the backfill worklist

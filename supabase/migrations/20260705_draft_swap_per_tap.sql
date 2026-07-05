-- Draft keg swaps become fully per-tap + deterministic.
--
-- 1. Swap config (which cold-storage keg to drain, and the full-keg recount
--    level) moves from per-recipe (taproom_recipe_settings) to per-tap
--    (tap_assignments), next to restock_variation_id. Same recipe on two taps
--    stores the config twice, intentionally — the tap fully describes its swap.
-- 2. draft_swap_shrinkage records the beer left in a keg at swap time, keyed by
--    the restock line's source_ref so the sync upserts it idempotently. Replaces
--    the old count-crossing inference that drove the Draft Shrinkage chart.

alter table public.tap_assignments
  add column if not exists swap_variation_id uuid
    references public.packaging_variations(id) on delete set null;

alter table public.tap_assignments
  add column if not exists swap_volume_fl_oz numeric;

-- Backfill each tap from the recipe it currently runs.
update public.tap_assignments t
   set swap_variation_id = s.swap_variation_id,
       swap_volume_fl_oz = s.swap_volume_fl_oz
  from public.taproom_recipe_settings s
 where s.recipe_id = t.recipe_id
   and t.recipe_id is not null;

create table if not exists public.draft_swap_shrinkage (
  source_ref      text primary key,
  recipe_id       uuid references public.recipes(id) on delete cascade,
  tap_number      int,
  occurred_at     timestamptz not null,
  remaining_fl_oz numeric not null,
  full_fl_oz      numeric not null,
  created_at      timestamptz not null default now()
);

create index if not exists draft_swap_shrinkage_recipe_idx
  on public.draft_swap_shrinkage (recipe_id);

comment on table public.draft_swap_shrinkage is
  'Deterministic per-swap shrinkage: beer left in a keg when a Draft Restock line was rung. One row per restock source_ref.';

alter table public.taproom_recipe_settings drop column if exists swap_variation_id;
alter table public.taproom_recipe_settings drop column if exists swap_volume_fl_oz;

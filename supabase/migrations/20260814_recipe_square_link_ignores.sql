-- Square item-mapping "ignore" list.
-- An ignored cell = a (recipe, packaging-variation) slot deliberately left
-- unmapped. Ignored cells produce no suggestion, are excluded from auto-fill,
-- and show no "missing mapping" warning — but remain mappable later.
-- Grain mirrors recipe_square_links: draft is recipe-grain (variation_id null),
-- keg/can is variation-grain (recipe_id + variation_id).

create table if not exists public.recipe_square_link_ignores (
  id           uuid primary key default gen_random_uuid(),
  recipe_id    uuid not null references public.recipes(id) on delete cascade,
  packaging    text not null check (packaging in ('draft','keg','can')),
  variation_id uuid references public.packaging_variations(id) on delete cascade,
  created_at   timestamptz not null default now()
);

-- One ignore per keg/can cell (recipe + variation), and one per draft cell (recipe).
create unique index if not exists rsli_recipe_variation_uniq
  on public.recipe_square_link_ignores (recipe_id, variation_id)
  where variation_id is not null;
create unique index if not exists rsli_recipe_draft_uniq
  on public.recipe_square_link_ignores (recipe_id)
  where packaging = 'draft';

-- FK index (repo convention — cf. 20260721_add_missing_fk_indexes.sql).
create index if not exists rsli_variation_id_idx
  on public.recipe_square_link_ignores (variation_id);

-- Audit trail, matching recipe_square_links.
drop trigger if exists audit_recipe_square_link_ignores on public.recipe_square_link_ignores;
create trigger audit_recipe_square_link_ignores
  after insert or update or delete on public.recipe_square_link_ignores
  for each row execute function audit_trigger_fn();

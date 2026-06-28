-- Re-grain the product mapping from (recipe_id, container) to the
-- production-native packaging_variation grain. The old key cannot represent
-- two beer-specific variations that share a container but sell as different
-- Square SKUs (e.g. Epic Hazy "Printed Can" vs "Be Like Mike Labeled Can",
-- both 16oz can — migration 20260707). variation_id fixes that.
--
-- Draft is NOT a packaging_variation (it's poured, not vesselled) and stays a
-- recipe-grain row: variation_id NULL, keyed by (recipe_id) where
-- packaging='draft'. Keg/can rows become keyed by variation_id.
--
-- Backfill only sets variation_id where exactly ONE active variation matches a
-- link's (recipe, container); genuinely ambiguous rows are left NULL for the
-- management UI (Task 11) to resolve.

alter table public.recipe_square_links
  add column if not exists variation_id uuid
    references public.packaging_variations(id) on delete cascade;

-- Backfill unambiguous keg/can links.
--
-- NOTE on live schema: recipe_square_links in the live DB has NO
-- packaging_format column (the 20260627_three_channel_invoicing migration that
-- would have added it was never applied). The link's only physical-product
-- dimension is packaging_item_id (the container). We therefore match candidate
-- variations by recipe + container alone and only set variation_id where that
-- yields exactly ONE active variation. Recipes with multiple active variations
-- on the same container (e.g. a can recipe with both loose and 4-pack, or the
-- Be Like Mike / Printed Can collision) are genuinely ambiguous and are left
-- NULL for the management UI (Task 11) to resolve.
update public.recipe_square_links rsl
set variation_id = u.variation_id
from (
  -- count(*) = 1 guarantees a single candidate; array_agg works for uuid
  -- (Postgres has no min(uuid)).
  select link_id, (array_agg(variation_id))[1] as variation_id
  from (
    select l.id as link_id, pv.id as variation_id
    from public.recipe_square_links l
    join public.recipe_packaging_variations rpv on rpv.recipe_id = l.recipe_id
    join public.packaging_variations pv
      on pv.id = rpv.variation_id
     and pv.is_active = true
     and pv.container_id = l.packaging_item_id
    where l.packaging in ('keg', 'can')
      and l.packaging_item_id is not null
  ) candidates
  group by link_id
  having count(*) = 1
) u
where rsl.id = u.link_id
  and rsl.variation_id is null;

-- Drop the old container-based unique index (it enforces the collision by
-- keying product links on (recipe_id, packaging_item_id) rather than the
-- finer variation grain).
drop index if exists recipe_square_links_recipe_packaging_item_uniq;

-- One product link per packaging_variation.
create unique index if not exists rsl_variation_uniq
  on public.recipe_square_links (variation_id)
  where variation_id is not null;

-- One draft link per recipe. (recipe_square_links_recipe_draft_uniq already
-- enforces draft uniqueness on (recipe_id, packaging) where packaging_item_id
-- IS NULL; this adds the packaging='draft' partial unique the new grain keys on
-- explicitly. Both are compatible — draft rows carry variation_id NULL.)
create unique index if not exists rsl_draft_uniq
  on public.recipe_square_links (recipe_id)
  where packaging = 'draft';

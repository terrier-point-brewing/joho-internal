-- ─────────────────────────────────────────────────────────────────────────────
-- DATA BACKFILL (not schema): repair recipe_square_links.variation_id for kegs
-- (and unambiguous cans), correcting the failed 20260710 container-grain backfill.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- ROOT CAUSE
-- The 20260710_recipe_square_links_variation_grain backfill matched candidate
-- packaging_variations on `pv.container_id = link.packaging_item_id` (through
-- recipe_packaging_variations). That key broke because:
--   • 20260627_printed_can_and_partner_kegs repointed partner kegs and printed
--     cans onto NEW beer-specific container items (packaging_items), so a link's
--     legacy packaging_item_id (a generic blank/keg container) no longer equals
--     any variation's container_id.
--   • Generic house kegs never received recipe_packaging_variations rows at all,
--     so the recipe→variation join found zero candidates for them.
-- Result: keg links are 0-candidate failures; can links are a mix of 0-candidate
-- and >1-candidate (ambiguous multi-format on a shared blank container). 50
-- non-draft rows are left with variation_id NULL.
--
-- THE FIX (deterministic for kegs)
-- Re-match by keg SIZE instead of container identity. A keg link's size is read
-- from its container item's volume_fl_oz (partner keg items carry the SAME volumes
-- as generics: 1984 / 992 / 661 fl oz). For each NULL keg link we resolve to
-- EXACTLY ONE variation via a coalesce of two count(*)=1-guarded matches:
--   1. PRIMARY  — a recipe-specific keg variation of that size, reached through
--      recipe_packaging_variations (each partner recipe has one keg variation per
--      size → count = 1).
--   2. FALLBACK — the single shared generic (partner_id IS NULL) keg variation of
--      that size, used ONLY when the recipe has no recipe-specific keg variation
--      of that size (house recipes). The rsl_variation_recipe_uniq index keys on
--      (variation_id, recipe_id), so a generic variation may be linked once per
--      recipe.
-- Cans are also resolved, but ONLY where the recipe has exactly ONE active can
-- variation of the link's size (count = 1). Genuinely multi-format / collision
-- cans (loose vs 4-pack vs case, or the Epic Hazy "Printed Can" vs "Be Like Mike
-- Labeled Can" 16oz collision) remain NULL for the mapping-grid UI to resolve.
--
-- SAFETY / OPERATIONS
--   • SAFE-BY-CONSTRUCTION: every match is guarded by `having count(*) = 1` (or,
--     for the generic fallback, a NOT EXISTS that forbids it when any recipe-
--     specific candidate exists). A row is updated only when the match resolves
--     to exactly ONE variation. Ambiguous or 0-candidate rows stay NULL — this
--     migration NEVER writes a wrong or guessed value.
--   • IDEMPOTENT: only `variation_id IS NULL` rows are touched; a re-run after the
--     first application is a no-op.
--   • NON-DESTRUCTIVE: this migration does NOT drop, rename, or null any column
--     (the legacy string columns square_variation_id / square_item_id /
--     variation_name / item_name are untouched — see
--     docs/recipe-square-links-legacy-column-retirement.md for their retirement).
--   • DRY-RUN FIRST: before applying, run each match CTE below as a SELECT to
--     eyeball the counts, e.g.:
--       -- keg links still needing repair, with derived size:
--       select l.id, l.recipe_id, pk.volume_fl_oz
--       from public.recipe_square_links l
--       join public.packaging_items pk on pk.id = l.packaging_item_id and pk.type = 'keg'
--       where l.packaging = 'keg' and l.variation_id is null;
--       -- and confirm the resolved set with the CTE query below (swap UPDATE for SELECT).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Kegs ──────────────────────────────────────────────────────────────────────
with keg_target as (
  -- NULL keg links, with the target keg size derived from the container item.
  select l.id as link_id, l.recipe_id, pk.volume_fl_oz as vol
  from public.recipe_square_links l
  join public.packaging_items pk
    on pk.id = l.packaging_item_id
   and pk.type = 'keg'
  where l.packaging = 'keg'
    and l.variation_id is null
    and l.packaging_item_id is not null
    and pk.volume_fl_oz is not null
),
-- PRIMARY: recipe-specific keg variation of the same size (via recipe_packaging_variations).
-- array_agg((…))[1] is used because Postgres has no min(uuid); count(*) = 1 makes
-- the pick deterministic (a single candidate).
keg_primary as (
  select t.link_id, (array_agg(pv.id))[1] as variation_id
  from keg_target t
  join public.recipe_packaging_variations rpv on rpv.recipe_id = t.recipe_id
  join public.packaging_variations pv
    on pv.id = rpv.variation_id
   and pv.is_active = true
  join public.packaging_items pc
    on pc.id = pv.container_id
   and pc.type = 'keg'
   and pc.volume_fl_oz = t.vol
  group by t.link_id
  having count(*) = 1
),
-- FALLBACK: the single shared generic (partner_id NULL) keg variation of that size,
-- used ONLY when the recipe has NO recipe-specific keg variation of that size.
keg_fallback as (
  select t.link_id, (array_agg(pv.id))[1] as variation_id
  from keg_target t
  join public.packaging_variations pv
    on pv.is_active = true
   and pv.partner_id is null
  join public.packaging_items pc
    on pc.id = pv.container_id
   and pc.type = 'keg'
   and pc.volume_fl_oz = t.vol
  where not exists (
    select 1
    from public.recipe_packaging_variations rpv2
    join public.packaging_variations pv2
      on pv2.id = rpv2.variation_id
     and pv2.is_active = true
    join public.packaging_items pc2
      on pc2.id = pv2.container_id
     and pc2.type = 'keg'
     and pc2.volume_fl_oz = t.vol
    where rpv2.recipe_id = t.recipe_id
  )
  group by t.link_id
  having count(*) = 1
),
keg_resolved as (
  select t.link_id, coalesce(kp.variation_id, kf.variation_id) as variation_id
  from keg_target t
  left join keg_primary  kp on kp.link_id = t.link_id
  left join keg_fallback kf on kf.link_id = t.link_id
)
update public.recipe_square_links rsl
set variation_id = r.variation_id
from keg_resolved r
where rsl.id = r.link_id
  and r.variation_id is not null
  and rsl.variation_id is null;

-- ── Cans (unambiguous only) ───────────────────────────────────────────────────
-- Resolve can links the same size-safe way, but ONLY when the recipe has exactly
-- ONE active can variation of the link's size. Multi-format / collision cans stay
-- NULL (count(*) <> 1) for the mapping-grid UI to disambiguate.
with can_target as (
  select l.id as link_id, l.recipe_id, pk.volume_fl_oz as vol
  from public.recipe_square_links l
  join public.packaging_items pk
    on pk.id = l.packaging_item_id
   and pk.type = 'can'
  where l.packaging = 'can'
    and l.variation_id is null
    and l.packaging_item_id is not null
    and pk.volume_fl_oz is not null
),
can_match as (
  select t.link_id, (array_agg(pv.id))[1] as variation_id
  from can_target t
  join public.recipe_packaging_variations rpv on rpv.recipe_id = t.recipe_id
  join public.packaging_variations pv
    on pv.id = rpv.variation_id
   and pv.is_active = true
  join public.packaging_items pc
    on pc.id = pv.container_id
   and pc.type = 'can'
   and pc.volume_fl_oz = t.vol
  group by t.link_id
  having count(*) = 1
)
update public.recipe_square_links rsl
set variation_id = m.variation_id
from can_match m
where rsl.id = m.link_id
  and m.variation_id is not null
  and rsl.variation_id is null;

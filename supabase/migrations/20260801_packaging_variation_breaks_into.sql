-- supabase/migrations/20260801_packaging_variation_breaks_into.sql
--
-- Cases are physically built by paktech-ing loose cans into 4-packs or
-- 6-packs, then boxing those packs into a tray -- so a case's cold-storage
-- break-down must crack into the SPECIFIC pack size it was built from.
-- The prior break-down planner (lib/production/coldStorageBreak.ts) had no
-- way to know which one: it picked whichever pack sibling was numerically
-- closest by volume, which is only correct by accident when a recipe has
-- just one pack sibling. Any recipe selling both a 4-pack and a 6-pack of
-- the same can would silently get the wrong answer. This makes the link
-- explicit instead of inferred.

alter table public.packaging_variations
  add column if not exists breaks_into_variation_id uuid
    references public.packaging_variations(id) on delete restrict;

alter table public.packaging_variations
  drop constraint if exists packaging_variations_breaks_into_not_self;
alter table public.packaging_variations
  add constraint packaging_variations_breaks_into_not_self
  check (breaks_into_variation_id is null or breaks_into_variation_id <> id);

alter table public.packaging_variations
  drop constraint if exists packaging_variations_breaks_into_case_only;
alter table public.packaging_variations
  add constraint packaging_variations_breaks_into_case_only
  check (format = 'case' or breaks_into_variation_id is null);

create index if not exists packaging_variations_breaks_into_idx
  on public.packaging_variations(breaks_into_variation_id);

-- Backfill existing case rows where exactly one 4-pack/6-pack sibling shares
-- the case's can-identity (container + lid + label + partner, null-safe).
-- Also backfills the case's paktech_id to match that pack's paktech_id --
-- it's the same physical PakTech used to build the case. Families with an
-- ambiguous >1 pack sibling (both a 4-pack and 6-pack) are left null; there
-- is no way to infer which one actually built a given case from data alone
-- and they need a human to pick in the Packaging Variations UI.
with fam as (
  select
    c.id as case_id,
    p.id as pack_id,
    p.paktech_id as pack_paktech_id
  from public.packaging_variations c
  join public.packaging_variations p
    on p.container_id = c.container_id
   and p.lid_id     is not distinct from c.lid_id
   and p.label_id   is not distinct from c.label_id
   and p.partner_id is not distinct from c.partner_id
   and p.format in ('4-pack', '6-pack')
  where c.format = 'case'
),
unambiguous as (
  select
    case_id,
    (array_agg(pack_id))[1]          as pack_id,
    (array_agg(pack_paktech_id))[1]  as pack_paktech_id
  from fam
  group by case_id
  having count(*) = 1
)
update public.packaging_variations c
set breaks_into_variation_id = u.pack_id,
    paktech_id = coalesce(c.paktech_id, u.pack_paktech_id)
from unambiguous u
where c.id = u.case_id
  and c.breaks_into_variation_id is null;

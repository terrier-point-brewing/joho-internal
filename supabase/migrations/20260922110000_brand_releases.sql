-- Brand releases — the spine a release's components hang off.
--
-- A release is the operational unit of "putting out a new beer": one row that
-- names the release, places it in a season (S# | E#), links the Production
-- recipe it pours, and carries the release-card copy (story line, menu
-- description, naming check). Components that are WORKFLOWS rather than facts
-- get their own tables keyed by release_id — today that is only the label
-- (brand_labels, extended below with its three tracked stages); apparel,
-- merch, and marketing land later as sibling tables without touching this one.
--
-- ── WHY THE CARD FIELDS LIVE ON THE SPINE ───────────────────────────────────
-- Name/story/menu/naming-check aren't a process with stages; they ARE the
-- release's identity, and the brand guide's "Writing a release card" template
-- renders exactly these rows. A separate release-card table would be a 1:1
-- with nothing to say.
--
-- ── WHY EPISODE IS HERE AND NOT ON SEASONS ──────────────────────────────────
-- Seasons (brand_seasons) already carry everything downstream artifacts share
-- (ground color, chop glyph, motif set, logo). An episode is one release's
-- POSITION within its season — a fact about the release. Unique per season so
-- "S2 | E4" names exactly one release.
--
-- ── BACKFILL ────────────────────────────────────────────────────────────────
-- Every existing brand_labels row becomes a release, REUSING THE LABEL'S ID as
-- the release id (fresh table, so no collision) — that gives an exact 1:1
-- mapping without name-matching. The label's card-ish fields (name,
-- description→story_line, naming_check) move up to the release; its design
-- fields (tier2_palette, chop glyph) stay put. Legacy label columns are kept,
-- not dropped — same posture as canon schema changes.
--
-- RLS enabled with no policies, matching every brand table: writes go through
-- createSupabaseAdminClient() behind requirePermission().
--
-- Human-gated (do not auto-apply).

create table if not exists public.brand_releases (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  story_line       text,
  menu_description text,
  naming_check     jsonb not null default '{"results":[]}'::jsonb,
  season_id        uuid references public.brand_seasons(id) on delete set null,
  episode          int check (episode is null or episode >= 1),
  -- set null, not cascade: deleting a recipe must not erase the release; the
  -- recipe card simply reverts to "not linked".
  recipe_id        uuid references public.recipes(id) on delete set null,
  status           text not null default 'draft'
                   check (status in ('draft','released','archived')),
  created_by       uuid,
  created_at       timestamptz not null default now(),
  released_at      timestamptz
);

-- "S2 | E4" must name exactly one release.
create unique index if not exists brand_releases_season_episode
  on public.brand_releases (season_id, episode)
  where season_id is not null and episode is not null;

alter table public.brand_releases enable row level security;

-- ── Label component: attach to the spine, grow the three tracked stages ─────
alter table public.brand_labels
  add column if not exists release_id   uuid references public.brand_releases(id) on delete cascade,
  -- The Production label SKU (packaging_items, type 'label') this design is
  -- printed onto. Set from the print stage; lets the release frame read LIVE
  -- label stock instead of keeping a duplicate hand-written "received" fact.
  -- Receiving stays in Production's stock adjustments, which already drive
  -- costing and canning.
  add column if not exists packaging_item_id uuid references public.packaging_items(id) on delete set null,
  -- {request_brief, artist_name, artist_contact, requested_at, expected_delivery,
  --  asset_ids: uuid[], received_at, notes}
  add column if not exists illustration jsonb not null default '{}'::jsonb,
  -- {submitted_at, approved, approved_at, reference, notes}
  add column if not exists regulatory   jsonb not null default '{}'::jsonb,
  -- {printer, quantity, specs, ordered_at, received_at, notes}
  add column if not exists print_order  jsonb not null default '{}'::jsonb;

-- One label component per release.
create unique index if not exists brand_labels_one_per_release
  on public.brand_labels (release_id)
  where release_id is not null;

-- ── Backfill: one release per existing label, sharing the label's id ────────
insert into public.brand_releases (id, name, story_line, naming_check, status, created_at)
select l.id, l.name, l.description,
       coalesce(l.naming_check, '{"results":[]}'::jsonb),
       case when l.status = 'archived' then 'archived' else 'draft' end,
       l.created_at
from public.brand_labels l
where l.release_id is null
on conflict (id) do nothing;

update public.brand_labels set release_id = id where release_id is null;

-- Verification:
--   select count(*) from brand_releases;                          -- = label count
--   select count(*) from brand_labels where release_id is null;   -- 0

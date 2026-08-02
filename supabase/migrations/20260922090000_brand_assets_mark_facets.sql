-- Marks rework — the facets a mark card is built from.
--
-- The Marks tab used to render cards out of canon JSON (`marks[].variants[]`),
-- with the uploaded file attached to a variant by id afterwards. That made
-- every new chop a two-step act: upload the file, then go author a variant for
-- it. It also had no way to say the two things that actually distinguish the
-- marks from each other — which season a chop belongs to, and how one wordmark
-- variation differs from the next.
--
-- So the facets move onto the asset itself, and the guide renders cards
-- straight from approved assets. Canon `marks` keeps the written rules
-- (usage, clearspace, the one rule) — the part that is genuinely prose.
--
-- Human-gated (do not auto-apply).

-- ── Chop facets ─────────────────────────────────────────────────────────────
-- Chops are cut per season: same color, same frame, different content. A null
-- season is the generic chop — the fallback used when no season claims one.
-- ON DELETE SET NULL, not CASCADE: deleting a season must not delete artwork.
alter table public.brand_assets
  add column if not exists season_id uuid references public.brand_seasons(id) on delete set null;

-- ── Shared ──────────────────────────────────────────────────────────────────
-- For a chop: what the glyph depicts. For a wordmark: when to reach for this
-- variation. Distinct from `alt_text`, which describes the image for a screen
-- reader — this is editorial, and both are shown.
alter table public.brand_assets
  add column if not exists description text;

-- ── Wordmark variation facets ───────────────────────────────────────────────
-- The three axes a wordmark variation actually varies on. Every variation is
-- the same drawing; only these differ. Nullable throughout — they are
-- meaningless on a texture or a photo, and unset on anything uploaded before
-- this migration.
alter table public.brand_assets
  add column if not exists shape text
    check (shape is null or shape in ('square', 'rectangular', 'other'));

-- Free text rather than an enum: the values name brand colors ("Indigo",
-- "Paper"), and the palette is canon data that admins edit. An enum here would
-- have to be migrated every time a color is renamed. The editor offers the
-- current palette as a datalist; the column just stores what was chosen.
alter table public.brand_assets
  add column if not exists color_treatment text;

-- The ground the artwork ships on: 'none' for a transparent file, otherwise a
-- palette color name. Same reasoning as color_treatment.
alter table public.brand_assets
  add column if not exists background text;

-- ── One approved row per (kind, variant, FORMAT) ────────────────────────────
-- Was (kind, variant): approving the PNG of a variation archived its SVG, so a
-- variation could never offer both at once. A card that toggles between them
-- needs both approved, and they are the same variation — same variant slug,
-- different file.
--
-- Widening a uniqueness constraint cannot invalidate existing rows.
drop index if exists public.brand_assets_one_approved;
create unique index if not exists brand_assets_one_approved
  on public.brand_assets (kind, variant, format) where status = 'approved';

-- The guide groups approved chops by season on every render of the Marks tab.
create index if not exists brand_assets_chop_season
  on public.brand_assets (season_id) where kind = 'chop_glyph';

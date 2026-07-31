-- Brand templates, seasons and outputs — the render pipeline's data layer.
--
-- A template is a base layout plus named slots plus rules on each; rendering is
-- `template + slot inputs + active season → artifact`. These three tables hold
-- the template, the season it resolves motifs from, and the record of every
-- artifact produced.
--
-- Nothing here renders anything. This phase lands the schema, the slot model
-- (lib/brand/slots.ts) and the constraint validator (lib/brand/validateSlots.ts);
-- the SVG→PNG/PDF pipeline is the next phase.
--
-- ── CONVENTIONS FOLLOWED ────────────────────────────────────────────────────
-- RLS is enabled with NO write policy on all three, matching every existing
-- brand table: writes go through createSupabaseAdminClient() from route
-- handlers gated by requirePermission(). There is no anon SELECT either — the
-- whole /brand tree is session-gated and reads through the admin client, which
-- is the posture 20260903 deliberately moved brand_assets to.
--
-- ── WHY TEMPLATES ARE VERSIONED AND ASSETS ARE NOT ──────────────────────────
-- An asset is a file: every upload already gets its own immutable id and its own
-- bytes, so pinning an output to an asset_id is enough to say exactly what
-- shipped. A template is data that gets edited in place, so reproducing a March
-- render needs the slot and constraint set AS IT WAS. Hence (key, version).
--
-- Human-gated (do not auto-apply).

-- ── Templates ───────────────────────────────────────────────────────────────
create table if not exists public.brand_templates (
  id             uuid primary key default gen_random_uuid(),
  -- Stable slug shared by every version of a template: 'beer-label'.
  key            text not null,
  version        int  not null default 1,
  name           text not null,
  medium         text not null
                 check (medium in ('label','menu','social','apparel','signage','collateral')),
  status         text not null default 'draft'
                 check (status in ('draft','published','archived')),
  -- Storage path in the existing private `brand-assets` bucket. Nullable: a
  -- template's slots and constraints are authored before its artwork exists.
  base_svg_path  text,
  slots          jsonb not null default '[]'::jsonb,   -- Slot[]      — lib/brand/slots.ts
  constraints    jsonb not null default '{}'::jsonb,   -- template-wide rules
  renditions     jsonb not null default '[]'::jsonb,   -- Rendition[] — lib/brand/slots.ts
  notes          text,
  created_by     uuid,
  created_at     timestamptz not null default now(),
  published_at   timestamptz,
  unique (key, version)
);

-- At most one published version per key, same partial-index pattern as
-- brand_canon_one_published and brand_assets_one_approved.
create unique index if not exists brand_templates_one_published
  on public.brand_templates (key) where status = 'published';

alter table public.brand_templates enable row level security;

-- ── Seasons ─────────────────────────────────────────────────────────────────
-- A season is what a `motif` slot resolves against. The canon's chop spec says
-- what rotates: "Glyph only — script or symbol per active motif family... The
-- glyph rotates per motif family." So a season resolves to a background color
-- and a chop glyph, and the glyph is an asset reference rather than a name.
create table if not exists public.brand_seasons (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,                    -- "Season 1"
  chop_glyph_asset_id  uuid references public.brand_assets(id) on delete set null,
  -- The seasonal ground. A hex rather than a token reference on purpose: a
  -- season's color is a NEW value the palette does not already carry, which is
  -- exactly the case the token indirection cannot express.
  background_hex       text check (background_hex is null or background_hex ~* '^#[0-9a-f]{6}$'),
  cultural_lean        text,
  motif_set            jsonb not null default '[]'::jsonb,  -- [{assetId, note}]
  season_logo_asset_id uuid references public.brand_assets(id) on delete set null,
  starts_at            date,
  ends_at              date,
  status               text not null default 'draft'
                       check (status in ('draft','active','archived')),
  created_by           uuid,
  created_at           timestamptz not null default now(),
  check (ends_at is null or starts_at is null or ends_at >= starts_at)
);

-- Exactly one active season at a time — "the active season" has to name one row
-- or every motif slot has an ambiguous source.
create unique index if not exists brand_seasons_one_active
  on public.brand_seasons ((status)) where status = 'active';

alter table public.brand_seasons enable row level security;

-- ── Outputs ─────────────────────────────────────────────────────────────────
create table if not exists public.brand_outputs (
  id               uuid primary key default gen_random_uuid(),
  -- restrict, not cascade: an output is a record of something that shipped, and
  -- deleting the template must not silently erase what it produced.
  template_id      uuid not null references public.brand_templates(id) on delete restrict,
  template_version int  not null,
  rendition        text not null,
  season_id        uuid references public.brand_seasons(id) on delete set null,
  label_id         uuid references public.brand_labels(id) on delete set null,
  inputs           jsonb not null default '{}'::jsonb,   -- slot key -> value

  -- ── Reproducibility ──
  -- The FK is the convenience join; the snapshot is the record of truth. Canon
  -- rows are normally archived rather than deleted, but 20260813 did delete the
  -- v1.0 rows, so the FK alone is not a durable guarantee.
  canon_version_id uuid references public.brand_canon_versions(id) on delete set null,
  tokens_snapshot  jsonb not null default '{}'::jsonb,   -- role -> hex, as actually used
  -- [{slot, assetId}] — the exact assets used. This is what makes "no asset
  -- versioning" sufficient: an output names the immutable rows it drew from.
  asset_refs       jsonb not null default '[]'::jsonb,

  status           text not null default 'draft'
                   check (status in ('draft','approved','exported')),
  -- Nothing an agent produces may skip the human gate, so the origin is
  -- recorded on the row rather than inferred from who happened to create it.
  source           text not null default 'human'
                   check (source in ('human','agent')),
  rendered_path    text,
  render_meta      jsonb not null default '{}'::jsonb,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  approved_at      timestamptz,
  exported_at      timestamptz
);

create index if not exists brand_outputs_template_idx on public.brand_outputs (template_id);
create index if not exists brand_outputs_label_idx    on public.brand_outputs (label_id);
create index if not exists brand_outputs_status_idx   on public.brand_outputs (status);

alter table public.brand_outputs enable row level security;

-- Verification:
--   select table_name, row_security from information_schema.tables t
--   join pg_class c on c.relname = t.table_name
--   where table_name in ('brand_templates','brand_seasons','brand_outputs');

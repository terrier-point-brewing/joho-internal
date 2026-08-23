-- ============================================================================
-- Season kits — somewhere for a season to live beyond a ground and a glyph.
--
-- `brand_seasons` was modelled for LABELS. Its own comment in
-- 20260908090000 says why: the canon fixes a chop's "position, footprint, color
-- and rendering", so a season only ever had to carry the two things a `motif`
-- slot resolves — a ground colour and a chop glyph. For a can that is exactly
-- right. For a feed it is not: a season that has to hold up across social needs
-- what its photography looks like, and how it sounds, and neither is a
-- placement rule, so neither belongs in the canon.
--
-- THE ORGANISING RULE, which every choice below follows from:
--   A SEASON SELECTS AND INFLECTS. IT NEVER REDEFINES.
-- The canon owns the brand's colours, type, voice and placement. A season
-- chooses from that set and adds a seasonal layer on top. It may not introduce
-- a brand colour or contradict the canon — and if it seems to need to, the
-- canon is what should change.
--
-- Design: docs/brand/season-kit-spec.md · brief: docs/brand/chips/01-season-kit-schema.md
--
-- This file is storage and nothing else. No TypeScript, no route, no UI reads
-- any of it yet; chips 2 and 3 bring the board, the clone path and the
-- completeness gate. Everything here is additive — no pre-existing object is
-- altered, dropped or backfilled.
--
-- Re-runnable end to end: every statement is guarded, and the `motif_set` copy
-- is `on conflict do nothing`.
-- ============================================================================

-- ─── 1. brand_seasons.palette — roles, not colours ──────────────────────────
--
-- A map of role → CANON TOKEN KEY. Two roles and no more: `ink` and `accent`.
--
-- `ground` is deliberately NOT a role here. The season ground is the one colour
-- a season genuinely owns — a new value the canon does not already carry, which
-- is precisely the case the token indirection cannot express — and it already
-- lives in `background_hex`, with its own hex CHECK, since 20260908090000.
-- Adding a `ground` role would give one fact two homes.
--
-- Everything else points at a token key rather than a hex so that a canon
-- change PROPAGATES, and so a season cannot quietly invent a fourth brand
-- colour by typing one in.
alter table public.brand_seasons
  add column if not exists palette jsonb not null default '{}'::jsonb;

-- ─── 2. brand_seasons.voice_note — an inflection, not a voice ───────────────
-- One or two sentences on how this season sounds. The canon owns the voice;
-- this bends it. If it ever reads like a replacement, it is wrong.
alter table public.brand_seasons
  add column if not exists voice_note text;

-- ─── 3. The palette's SHAPE is constrained here; its VOCABULARY is not ──────
--
-- What this asserts: `palette` is an object, it carries no key beyond `ink` and
-- `accent`, and each value present is a lowercase slug — which is what both a
-- canon palette key ('seal-red', 'paper-2') and a canon role name
-- ('on-primary') look like, and which a raw hex ('#8a1c1c') is not.
--
-- What it deliberately does NOT assert: WHICH token keys are legal. The valid
-- set is whatever the canon currently declares, and that document is edited
-- through the app, not through migrations. An enumerated CHECK over another
-- system's vocabulary is the mistake 20260913090000 and
-- `project_constrain_casing_not_vocabulary` both record — it breaks the moment
-- the other side adds a word. Constrain the shape in SQL, the vocabulary in
-- TypeScript: resolving a role against the live canon belongs in `lib/brand/`.
--
-- Written scalar (no subquery, no set-returning function) because a CHECK
-- constraint may contain neither. With exactly two legal roles, naming them
-- twice costs less than an IMMUTABLE helper function would.
--
-- Guarded by pg_constraint rather than `drop constraint if exists` + `add` so
-- that a replay is a true no-op and never momentarily leaves the table
-- unconstrained.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.brand_seasons'::regclass
      and conname  = 'brand_seasons_palette_shape'
  ) then
    alter table public.brand_seasons
      add constraint brand_seasons_palette_shape check (
        jsonb_typeof(palette) = 'object'
        -- Subtracting the two legal keys must leave nothing behind.
        and palette - 'ink' - 'accent' = '{}'::jsonb
        and ( not palette ? 'ink'
              or ( jsonb_typeof(palette -> 'ink') = 'string'
                   and palette ->> 'ink' ~ '^[a-z][a-z0-9-]*$' ) )
        and ( not palette ? 'accent'
              or ( jsonb_typeof(palette -> 'accent') = 'string'
                   and palette ->> 'accent' ~ '^[a-z][a-z0-9-]*$' ) )
      );
  end if;
end $$;

comment on column public.brand_seasons.palette is
  'Season palette ROLES → canon token keys: {"ink": "...", "accent": "..."}. Never a raw hex — storing a key means a canon change propagates and a season cannot invent a brand colour. `ground` is deliberately absent: the season ground is the season''s own and lives in background_hex. The CHECK constrains shape only; which token keys are valid is resolved against the live canon in lib/brand/.';

comment on column public.brand_seasons.voice_note is
  'One or two sentences on how this season sounds. An INFLECTION of the canon''s voice, never a replacement.';

-- ─── 4. brand_season_assets — the season's visual vocabulary, as rows ───────
--
-- A row, not a string inside a jsonb blob. An asset here has to be ordered,
-- re-roled, removed and queried, and this repo has already paid for that lesson
-- once (`20261016090000_ingredient_unit_vocabulary.sql`): a list that lives in
-- a document can only be rewritten wholesale.
--
-- `role` is in the primary key because the SAME asset may legitimately hold two
-- roles in one season — a texture that is also a motif is one file, two jobs.
--
-- `role`'s CHECK enumerates a vocabulary this migration itself declares, which
-- is not the mistake §3 avoids: these three words are ours, not another
-- system's, and adding a fourth is a deliberate schema decision.
--
-- on delete cascade on the season (the kit is part of the season, and a deleted
-- season should not leave orphan rows) but NOT on the asset: the default
-- `no action` means an asset still used by a season cannot be deleted out from
-- under it, which is the safer failure.
--
-- No `updated_at`, and therefore no `public.update_updated_at()` trigger. A
-- membership row is added, reordered and removed rather than amended, and the
-- brief is explicit that an `updated_at` should not be invented for the sake of
-- having one.
create table if not exists public.brand_season_assets (
  season_id  uuid not null references public.brand_seasons(id) on delete cascade,
  asset_id   uuid not null references public.brand_assets(id),
  role       text not null check (role in ('motif', 'example', 'texture')),

  -- Display order within (season, role). Dense-from-zero by convention, but not
  -- enforced: a reorder that has to renumber every sibling atomically is a UI
  -- problem, and a unique constraint here would make the obvious swap fail.
  position   int  not null,

  -- The per-item note the spec asks motifs to carry, and the note `motif_set`
  -- entries already had a slot for ({assetId, note?}). Without it the copy in
  -- §5 would silently drop half of each entry.
  note       text,

  created_at timestamptz not null default now(),

  primary key (season_id, asset_id, role)
);

comment on table public.brand_season_assets is
  'A season''s asset kit: motifs, examples and textures, ordered per role. Rows rather than brand_seasons.motif_set''s jsonb array, so an asset can be ordered, re-roled and queried. The same asset may hold more than one role in a season, which is why role is in the key. RLS: grant-aware policies on scope brand.templates.';

comment on column public.brand_season_assets.role is
  'motif | example | texture. This vocabulary is declared by this migration, not borrowed from another system — extending it is a deliberate schema change.';

comment on column public.brand_season_assets.position is
  'Display order within (season_id, role). Zero-based by convention; not uniquely constrained, so a reorder can pass through a duplicate.';

-- The read this table exists to serve: "give me this season's motifs, in order".
create index if not exists brand_season_assets_season_role_position_idx
  on public.brand_season_assets (season_id, role, position);

-- Covers the asset_id foreign key, which advisor 0001 flags unindexed, and
-- answers the reverse question — "which seasons use this asset?" — that an
-- asset-deletion check has to ask.
create index if not exists brand_season_assets_asset_id_idx
  on public.brand_season_assets (asset_id);

-- ─── 5. Copy motif_set into rows ────────────────────────────────────────────
--
-- `motif_set` is a jsonb array of {assetId, note?}. Each entry becomes a
-- `role='motif'` row, `position` taken from array order.
--
-- NOTHING READS `motif_set` TODAY — `SeasonEditor.tsx` says so in as many
-- words, and it is absent from that editor for exactly that reason — so there
-- is no compatibility to preserve. The column is nonetheless LEFT IN PLACE.
-- Dropping it is a separate decision, correctly made once the UI writes rows
-- instead, and this file has to stay re-runnable without destroying anything.
--
-- `on conflict do nothing` is what makes a replay a no-op. In practice this
-- copies ZERO rows today: there is one season, "Season 1", and its motif_set is
-- `[]`. That is not a data migration that happened to be small — no data moved.
--
-- Two filters, both about not failing on a row nobody has validated:
--   * a non-uuid assetId would raise on the cast, so it is filtered out first,
--     behind a MATERIALIZED CTE that stops the planner hoisting the cast above
--     its own guard;
--   * an assetId naming an asset that no longer exists would raise on the
--     foreign key, so it is skipped rather than taking the migration down.
-- Either would be a corrupt entry, and a corrupt entry is a thing to notice
-- later, not a reason a schema change cannot be applied.
with entries as materialized (
  select
    s.id                              as season_id,
    e.value ->> 'assetId'             as asset_text,
    nullif(e.value ->> 'note', '')    as note,
    (e.ordinality - 1)::int           as position
  from public.brand_seasons s
  cross join lateral jsonb_array_elements(s.motif_set)
    with ordinality as e(value, ordinality)
  where jsonb_typeof(s.motif_set) = 'array'
),
well_formed as materialized (
  select season_id, asset_text::uuid as asset_id, note, position
  from entries
  where asset_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
)
insert into public.brand_season_assets (season_id, asset_id, role, position, note)
select w.season_id, w.asset_id, 'motif', w.position, w.note
from well_formed w
where exists (select 1 from public.brand_assets a where a.id = w.asset_id)
on conflict (season_id, asset_id, role) do nothing;

-- ─── 6. RLS ─────────────────────────────────────────────────────────────────
--
-- `brand.templates`, because authoring a season is template-tier work — the
-- same scope `SeasonEditor` already sits behind, and the same scope a hired
-- seasonal designer would be granted and nothing else.
--
-- The house applicator, not a hand-written pair: it is the single edit-point
-- that keeps every grant-gated table's policies identical, and it is itself
-- idempotent (drop if exists, then create), so re-running this file leaves the
-- same two policies with the same definitions.
--
-- NOTE ON POSTURE, recorded because it differs from this table's neighbours:
-- every other brand_* table sits service-role-only with RLS on and zero
-- policies (20261003090003 lists them). This one carries policies
-- deliberately, per docs/brand/season-kit-spec.md §8 — the kit is authored by
-- RLS: service-role only, with NO policies, matching every other brand_* table.
--
-- An earlier draft of this migration called apply_grant_policies() here, which
-- would have made this the first brand_* table with an `authenticated` read
-- surface. brand_assets, brand_seasons, brand_templates, brand_outputs,
-- brand_releases, brand_canon_versions and brand_labels all carry RLS with zero
-- policies — the posture 20261003090003 set deliberately — and a CHILD table
-- readable over the Data API while its own parent is not would be incoherent.
--
-- Nothing needs the surface either: /api/brand/seasons reads through
-- createSupabaseAdminClient() behind requirePermission(CAP.brandTemplatesRead),
-- exactly as every other brand route does, and service_role bypasses RLS. The
-- gate on this data is the route's, and it already exists.
alter table public.brand_season_assets enable row level security;

-- ─── Rollback ───────────────────────────────────────────────────────────────
-- Executed once inside a rolled-back transaction to prove it is complete and
-- correct. Kept commented because a migration that can undo itself on replay is
-- not a migration. It does NOT touch `motif_set`, which this file never
-- modified.
--
--   drop table if exists public.brand_season_assets;
--   alter table public.brand_seasons drop constraint if exists brand_seasons_palette_shape;
--   alter table public.brand_seasons drop column if exists palette;
--   alter table public.brand_seasons drop column if exists voice_note;
--
-- Dropping the table takes both indexes and both grant policies with it.

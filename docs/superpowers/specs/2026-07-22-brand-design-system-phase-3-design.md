# Brand & Design System — Phase 3 (Labels + Tier-2 Palettes) Design

**Date:** 2026-07-22
**Status:** Approved design, pending implementation plan
**Builds on:** Phases 0–2 (resolver, canon editor, asset library), all merged to `main`.

## Goal

Model each beer as a **label** — a story title + plain-style subtitle, a motif family, an earned Tier-2 palette, a 5-criteria naming check, and an assigned chop glyph — so the brand can grow one beer at a time and future AI generation (Phase 4) has structured per-label material to design from. Payoff now: a data-driven "Tap list" in the brand guide.

## Scope decisions (locked)

- **Tier-2 palette is a free named color list** (`{colors:[{name,hex,note?}]}`), NOT the 13 semantic UI role tokens. Tier-1 (canon roleMap) governs Joho-owned UI surfaces; Tier-2 is per-label *design material* (can art), consumed by Phase 4 AI — a different purpose, so it stays loosely structured.
- **Naming check is manual** — admin confirms each of the canon's 5 criteria (pulled live from `canon.naming.criteria`) with pass + optional note. AI-assisted naming is Phase 4.
- **Chop glyph** references an approved `chop_glyph` asset (Phase 2). Label art can be uploaded as a new `label_art` asset kind scoped to the label/motif (reuses the Phase 2 asset library).
- **`brand_assets` gains its deferred columns now** (`label_id`, `motif_family`) plus the `label_art` kind.

## Architecture

### 1. Schema (migration `20260811_brand_labels.sql`, human-gated)

```sql
create table if not exists public.brand_labels (
  id uuid primary key default gen_random_uuid(),
  name text not null,                    -- story title
  subtitle text,                         -- plain-style subtitle
  description text,
  motif_family text,
  status text not null default 'draft'
    check (status in ('draft','approved','archived')),
  tier2_palette jsonb not null default '{"colors":[]}',
  naming_check jsonb not null default '{"results":[]}',
  chop_glyph_asset_id uuid references public.brand_assets(id) on delete set null,
  created_by uuid, created_at timestamptz not null default now(),
  approved_at timestamptz
);
alter table public.brand_labels enable row level security;
create policy brand_labels_read_approved on public.brand_labels
  for select using (status = 'approved');   -- writes service-role only

-- brand_assets: land the deferred label columns + label_art kind
alter table public.brand_assets
  add column if not exists label_id uuid references public.brand_labels(id) on delete set null,
  add column if not exists motif_family text;
alter table public.brand_assets drop constraint if exists brand_assets_kind_check;
alter table public.brand_assets add constraint brand_assets_kind_check
  check (kind in ('logo','wordmark','chop_glyph','texture','icon','photo','label_art'));
```
Header ends "Human-gated (do not auto-apply)."

### 2. `lib/brand/labels.ts`

Injected-client testable (same pattern as `canonWorkflow`/`assets`):
- Types: `BrandLabel`, `Tier2Palette = {colors:{name:string;hex:string;note?:string}[]}`, `NamingCheck = {results:{criterion:string;pass:boolean;note?:string}[]}`.
- `listLabels(client, filter?)`, `getLabel(client, id)`.
- `createLabel(client, {name, subtitle?, description?, motif_family?})` (status draft).
- `updateLabel(client, id, patch)` — details, `tier2_palette`, `naming_check`, `chop_glyph_asset_id`.
- `approveLabel(client, id)` / `archiveLabel(client, id)`.
- `resolveApprovedLabels(client)` — approved labels for the guide tap-list (cookieless-cacheable read).
- Pure helper: `syncNamingCheck(criteria: string[], existing: NamingCheck): NamingCheck` — reconciles stored results against the current canon criteria (adds missing, drops stale, preserves pass/note) — unit-tested.

### 3. API (`app/api/brand/labels/**`, admin-gated via `requireRole([])`, `apiError`)

- `GET /api/brand/labels` → `listLabels` (optional `?status=`).
- `POST /api/brand/labels` → `createLabel`.
- `GET /api/brand/labels/[id]` → `getLabel`.
- `PATCH /api/brand/labels/[id]` → `updateLabel` or `{action:'approve'|'archive'}`.
All `dynamic="force-dynamic"`. Reads for the guide use the cookieless cached path.

### 4. UI (`app/brand/labels`, admin)

- New **Labels** tab in `BrandNav` (adminOnly).
- `page.tsx` (client): labels list (name · subtitle · motif · status badge) + "New label"; selecting one opens an editor with facets:
  - *Details* — name, subtitle, description, motif_family (ops inputs).
  - *Naming check* — one row per canon criterion (from `canon.naming.criteria`, fetched), a pass toggle + note; uses `syncNamingCheck` so criteria stay current.
  - *Tier-2 palette* — add/remove named colors (name + hex picker + note).
  - *Chop glyph* — picker of approved `chop_glyph` assets (from the Phase 2 asset API), sets `chop_glyph_asset_id`.
  - Publish bar: Save, Approve/Archive.
- react-query hooks + `lib/query-keys.ts` `brandLabels` keys.

### 5. Payoff — guide "Tap list"

The guide viewer gains a Tap-list section: `resolveApprovedLabels` → each label as name (`font-brand-display`) — subtitle (`font-brand-body`) · motif, in the `.brand-surface` (light/dark). Auto-updates as labels are approved.

## Testing

- `syncNamingCheck` (pure) + label CRUD/approve workflow via fake client — keep `lib/**` ≥86%.
- API: admin-gate + happy path.

## Out of scope (later phases)

Phase 4 AI studio (generate label art from Tier-2 + brief; AI-assisted naming check) · Phase 5 public surface (per-label pages). Per-label theming via the role contract, label versioning, and Square-catalog linking are deferred.

## External decision points (need the founder)

- Apply migration `20260811_brand_labels.sql`.
- Provide real label content + chop-glyph assets.

## Decisions locked

- `brand_labels` table + `brand_assets` gains `label_id`/`motif_family`/`label_art` kind.
- Tier-2 = free named palette (not UI roles); naming check manual against live canon criteria; chop = FK to approved asset.
- Guide tap-list = the payoff surface.

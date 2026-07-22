# Brand & Design System — Phase 2 (Asset Library) Design

**Date:** 2026-07-22
**Status:** Approved design, pending implementation plan
**Builds on:** Phase 0 (resolver, tokens) + Phase 1 (canon editor + guide viewer), both merged to `main`.

## Goal

Give the brand system a place to **store, approve, and resolve brand assets** (logos, wordmark, chop glyphs, textures, icons, photos), so brand surfaces and future AI features can pull the right approved binary. Ships the infrastructure now; becomes fully valuable the moment real asset files are uploaded.

## Scope decisions (locked)

- **Kinds supported now:** `logo`, `wordmark`, `chop_glyph`, `texture`, `icon`, `photo`. `label_art` / `generated_artifact` (and their `label_id` / `source` / `generator_meta` columns) remain Phase 3/4.
- **Storage:** one **public** Supabase Storage bucket `brand-assets`. Brand assets are non-secret and the Phase 5 public site will need them; **approval gates what the app renders, not raw URL accessibility**.
- **Upload:** server-side via an admin route handler (`formData` → `createSupabaseAdminClient()` → bucket → `brand_assets` row). Service key stays server-only; the browser never holds it.
- **Self-hosted fonts: deferred** to Phase 5 — fonts already load via `next/font/google`; self-hosting only matters for the public site.

## Architecture

### 1. Schema + storage (migration `20260810_brand_assets.sql`, human-gated)

```sql
create table public.brand_assets (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in
    ('logo','wordmark','chop_glyph','texture','icon','photo')),
  variant text not null default 'default',      -- e.g. 'primary','paper','mono'
  storage_path text not null,                   -- path within the brand-assets bucket
  format text not null,                         -- svg|png|webp|jpg|pdf
  file_meta jsonb not null default '{}',        -- {width,height,bytes,mime}
  status text not null default 'draft'
    check (status in ('draft','approved','archived')),
  created_by uuid, created_at timestamptz not null default now(),
  approved_by uuid, approved_at timestamptz
);
-- one approved asset per (kind, variant): resolveAsset picks deterministically
create unique index brand_assets_one_approved
  on public.brand_assets (kind, variant) where status = 'approved';
alter table public.brand_assets enable row level security;
-- reads: approved rows readable by anon (future public site); writes: service-role only
create policy brand_assets_read_approved on public.brand_assets
  for select using (status = 'approved');
-- storage bucket (public read)
insert into storage.buckets (id, name, public) values ('brand-assets','brand-assets',true)
  on conflict (id) do nothing;
```
- The `brand_assets_one_approved` partial unique index means at most one approved asset per `(kind, variant)` — so `resolveAsset` is deterministic and "approve" must archive the prior approved one first (same archive-before-insert lesson as Phase 1's `publishDraft`).
- Header ends "Human-gated (do not auto-apply)."

### 2. `lib/brand/assets.ts`

- Pure: `publicUrlFor(path: string): string` → `${NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/brand-assets/${path}` (unit-tested).
- `resolveAsset(client, { kind, variant? }): Promise<string | null>` — the approved row's public URL, or null. `variant` defaults to `'default'`.
- `listAssets(client, filter?): Promise<BrandAsset[]>` — for the library UI.
- Workflow (admin, service client): `createAsset(client, { kind, variant, storagePath, format, fileMeta })`, `approveAsset(client, id)` (archive prior approved for that kind+variant, then approve), `archiveAsset(client, id)`.
- Types: `BrandAsset`, `BrandAssetKind` (mirrors the check constraint).

### 3. API (`app/api/brand/assets/**`, admin-gated via `requireRole([])`, `apiError`)

- `GET /api/brand/assets` → `listAssets` (optional `?kind=` filter).
- `POST /api/brand/assets` → multipart `formData` (file + kind + variant): upload the file to the bucket via the admin client, then `createAsset` with the derived `storage_path`/`format`/`file_meta`. `export const dynamic = "force-dynamic"`.
- `PATCH /api/brand/assets/[id]` → `{action:'approve'|'archive'}`.
- Reads of approved assets for the guide/preview stay on the cookieless cached path (like `getCanon`).

### 4. Asset library UI (`app/brand/assets`, admin)

- New **Assets** tab in `BrandNav` (admin only).
- `page.tsx` (client): asset grid grouped by kind (thumbnail from public URL, variant, status badge), an upload form (file picker + kind + variant), and per-asset approve/archive actions. react-query hooks (`useAssets`, `useUploadAsset`, `useApproveAsset`, `useArchiveAsset`) with invalidation; keys in `lib/query-keys.ts`.
- Uploads use the ops chrome (the library lives in the dark tool); thumbnails render the actual asset.

### 5. Immediate payoff — wordmark in the guide

The guide viewer's wordmark switches from the interim Jost text to an `<img>` from `resolveAsset(client, { kind:'wordmark' })` when an approved wordmark exists; falls back to the text wordmark otherwise. First visible proof the asset system works end-to-end.

## Data flow

Admin uploads file → route handler stores it in `brand-assets` + inserts a `draft` row → admin approves → `approveAsset` archives any prior approved (kind,variant) and flips this to `approved` → `resolveAsset` (cookieless, cacheable) returns its public URL → guide/preview render it.

## Testing

- `publicUrlFor` + `resolveAsset`/`approveAsset` pure/workflow logic (archive-before-approve, one-approved invariant) unit-tested with an injected fake client — keep `lib/**` ≥86%.
- API routes: admin-gate rejection + happy path. Upload parsing covered where practical.

## Out of scope (later phases)

Phase 3 labels + Tier-2 palettes (`label_id`/`motif_family` columns) · Phase 4 AI studio (`source`/`generator_meta`, generated artifacts) · Phase 5 public surface + self-hosted fonts. Asset versioning/history beyond archive, and image processing/resizing, are deferred.

## External decision points (need the founder)

- Apply migration `20260810_brand_assets.sql` (creates the table + bucket) to prod — human-gated.
- Upload the actual brand asset files (logo, wordmark, chop glyphs) — the system holds them; the files come from you/a designer.

## Decisions locked

- Kinds: logo/wordmark/chop_glyph/texture/icon/photo. Public bucket; approval gates rendering, not accessibility.
- Server-side multipart upload via admin route; one approved per (kind, variant); archive-before-approve.
- Self-hosted fonts deferred to Phase 5.

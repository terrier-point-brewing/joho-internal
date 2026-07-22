# Brand & Design System — Phase 1 (Canon Editor + Guide Viewer) Design

**Date:** 2026-07-21
**Status:** Approved design, pending implementation plan
**Builds on:** Phase 0 (`docs/superpowers/specs/2026-07-19-brand-design-system-design.md`, PR #233). Assumes the `lib/brand` resolver, `brand_canon_versions` table, `--color-brand-*` tokens, and `BrandStyle` injection already exist.

## Goal

Make the Joho brand canon **editable in-app** (draft → live-preview → publish, with version history) and give the brewery a **human-facing brand guide** rendered from the canon. This is the phase that lets the founder tune the brand's look and evolve it (Joho→Tanka) without a redeploy, and the surface that gets employees aligned.

## Scope decisions (locked)

- **Editable granularity:** *visual* facets (Palette, Theme, Type) get structured form UIs with pickers + live preview; *text-heavy* Identity/Content (mission, voice, naming, precedence, agent rules) is edited as a single **zod-validated JSON block**. Full editability, minimal bespoke UI.
- **Workflow:** always edit *the* draft row; **Publish** snapshots it as a new published version, archives the prior published row, and revalidates the token cache. Immutable version history (read-only list). Rollback UI deferred to a later phase (the rows exist now).
- **Guide viewer:** a **data-driven branded document** rendered from canon content, not a recreation of the original artifact's bespoke visuals (those depend on Phase 2/3 assets).
- **Deferred Phase 0 hardening folds in here:** zod validation, `revalidateTag('brand-canon')` on publish, `createCookielessClient` env-fallback.

## Constraint: Type facet is bounded by build-time fonts

`next/font` loads families at build time; the editor can only **reassign roles among already-loaded families** (Marcellus / Lato / Jost / Noto Serif SC). Adding a brand-new family remains a code change. The Type facet therefore offers a fixed picker, not free-text family entry. (A future phase can add a self-hosted-font upload flow if needed.)

## Architecture

### 1. Schema (small additive migration)

`brand_canon_versions` (Phase 0) already has `status` (draft|published|archived), `version_label`, `document jsonb`, `changelog`, `created_by`, `created_at`, `published_at`, and a partial-unique index on one `published` row.

Phase 1 migration `supabase/migrations/2026XXXX_brand_canon_draft.sql` (next free number at build time; **human-gated**):
- add `updated_at timestamptz not null default now()`;
- add a partial unique index enforcing **at most one `draft` row** (`… ((status)) where status = 'draft'`);
- no data change.

### 2. Validation & types

- **`lib/brand/canon.schema.ts`** — a zod schema mirroring the Phase 0 canon shape. Add the `zod` dependency.
- **`lib/brand/canon.types.ts`** — becomes `export type BrandCanon = z.infer<typeof canonSchema>` (+ the `RoleName`/`FontRole` unions stay as authored, referenced by the schema). Single source of truth; a test asserts `seedCanon` parses clean and that the resolver still type-checks.

### 3. Workflow (server business logic)

**`lib/brand/canonWorkflow.ts`** — pure-where-possible, thin-API-friendly:
- `getDraft(client)` → the draft `document`; if no draft row exists, seed one from the current published row (or `seedCanon`) and return it.
- `saveDraft(client, document)` → zod-validate, upsert the single draft row, bump `updated_at`.
- `publishDraft(client, { versionLabel, changelog })` → zod-validate the draft, then in one transaction: insert a new `published` row (snapshot of the draft), flip the prior `published` row to `archived`, clear the draft; then `revalidateTag('brand-canon', 'max')`.
- `listVersions(client)` → published + archived rows (label, published_at, changelog), newest first.

Uses the admin/service-role Supabase client for writes (RLS write-restricted). Pure helpers (version-label bump, "which row to archive", validation) are unit-tested; the transaction is integration-shaped.

### 4. API (thin route handlers, admin-gated)

`app/api/brand/canon/**`, each wrapped with `apiError()` and gated by `getSessionUser` + `UserRole` (admin/founder to edit; viewer+ may read the published guide, which goes through `getCanon`, not these routes):
- `GET /api/brand/canon/draft` → current draft document
- `PUT /api/brand/canon/draft` → save draft (body = document)
- `POST /api/brand/canon/publish` → `{ versionLabel, changelog }`
- `GET /api/brand/canon/versions` → history list

### 5. UI (`app/brand/` area)

Brand-area shell following the per-area pattern (`app/brand/layout.tsx` + `nav-config.ts` + `BrandNav.tsx`): tabs **Guide** (viewer+), **Canon** (admin), **History** (admin).

- **Guide viewer** `app/brand/guide/page.tsx` — server component; `getCanon()` (published) → full-page `.brand-surface` in Joho light/dark with `ThemeToggle`. Sections from canon: hero (wordmark + mission), voice (summary + sliders + never/lean-on lists), color swatches (role · hex · ratio, click-to-copy), type specimen per font role, naming (pattern + 5 criteria + passing examples), agent rules + precedence. Reuses `app/components/brand/*` primitives; auto-updates on publish.
- **Canon editor** `app/brand/canon/page.tsx` (admin) — client; loads the draft, facet tabs:
  - *Palette* — editable color list (name, key, hex picker, CMYK/PMS text); add/remove.
  - *Theme* — per-role picker (palette key or raw hex) for light; dark shows the derived value with an override field + "reset to derived".
  - *Type* — role → family from the fixed loaded-font set + weights display.
  - *Content (JSON)* — zod-validated editor for mission/voice/naming/precedence/agentRules with inline errors.
  - *Live preview pane* — `<BrandPreview draft>` runs the pure `resolveTokens(draft)` client-side and applies tokens as **inline CSS custom properties on a scoped `.brand-surface` wrapper** (never `:root`, so the real app is untouched), with its own light/dark toggle.
  - *Publish bar* — unsaved/unpublished indicator, Save draft, version label + changelog inputs, Publish (confirm dialog).
- **History** `app/brand/canon/history` (or a section) — read-only published-version list (label · published_at · changelog).

React-query hooks (draft get/save/publish, versions) with invalidation; `lib/query-keys.ts` entries. UI uses ops-chrome primitives for the editor controls (the editor lives in the dark tool), and brand primitives for the preview/guide surfaces.

## Data flow

Editor (client draft state) → `PUT /draft` (persist) → `<BrandPreview>` renders draft via the pure resolver (client, scoped) → **Publish** → `publishDraft` snapshots + archives + `revalidateTag('brand-canon')` → `getCanon()` (and thus `BrandStyle` + the guide viewer) serve the new version on next request, no redeploy.

## Testing

- `canonWorkflow` pure helpers (version bump, archive-target selection, validation error paths) unit-tested; zod schema parse tests (seedCanon parses; malformed rejects). Keep `lib/**` coverage ≥86%.
- API routes: happy-path + admin-gate rejection.
- Resolver already tested (Phase 0); `BrandPreview`'s token→inline-style mapping gets a small unit test.

## Out of scope (later phases, unchanged roadmap)

Phase 2 asset library · Phase 3 labels + Tier-2 palettes · Phase 4 AI studio · Phase 5 public surface. One-click rollback, self-hosted-font upload, and structured (non-JSON) editing of the text sections are explicitly deferred.

## External decision points (need the founder)

- Apply the Phase 1 migration (and Phase 0's `20260808`) to prod — human-gated.
- Merge PR #233 (Phase 0) and this phase's PR.

## Decisions locked

- Visual facets structured (pickers + live preview); text facets = one zod-validated JSON block.
- Draft → preview → publish with immutable version history; rollback UI deferred.
- Guide viewer = data-driven branded document from canon.
- One-draft DB partial-unique index (not app-only).
- `canon.types.ts` derived from the zod schema via `z.infer`.
- Type facet limited to build-time-loaded font families.

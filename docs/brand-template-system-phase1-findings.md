# Brand Template System — Phase 1 findings (read-only audit)

Audited 2026-07-30 against the live Supabase project (`drlsazatrcrdwaihjmex`) and
branch `claude/brand-template-exploration-c43d33`. No writes, no migrations.

---

## 1. Database

Three brand tables are declared in `supabase/migrations/`. **Only two exist in production.**

| Table | Declared in | In prod? | Rows | State |
|---|---|---|---|---|
| `brand_canon_versions` | `20260808` (+ `20260809`, `20260902`) | ✅ | 6 | **Actively used.** 1 published (v1.4), 1 draft (v1.4), 4 archived (v1.0–1.3), all authored 23–28 Jul 2026. |
| `brand_assets` | `20260810` (+ `20260903`) | ✅ | **1** | **Barely used.** One approved `wordmark`/`horizontal-primary` SVG uploaded 30 Jul 2026. |
| `brand_labels` | `20260811` | ❌ **MISSING** | — | Migration never applied. See §1.3. |

### 1.1 `brand_canon_versions` — the real center of gravity

One `jsonb` `document` column holds the entire brand identity, validated by
`lib/brand/canon.schema.ts` (317 lines of Zod). Columns: `id, version_label,
status(draft|published|archived), document jsonb, changelog text, change_entries
jsonb, created_by, created_at, published_at, updated_at`. Two partial unique
indexes enforce at most one `published` and one `draft` row.

The published v1.4 document contains:

- `palette` — **13 colors**, each `{key, name, hex, tier(core|neutral), role?,
  cmyk?, pms?}`. The 4 core colors (indigo, paper, seal-red, camphor) **already
  carry CMYK and Pantone**. The 9 neutrals do not.
- `roleMap` — `{light, dark}`, 13 semantic roles each → a palette key.
- `usageRatios`, `colorForbidden` (4 illustrated rules), `illustrationLaw.rules`
  (6 illustrated rules) — both already migrated to the rich
  `{id, polarity, title, detail?, assetId?, caption?}` shape.
- `fonts` — 4 roles (display/body/wordmark/script). **No `source` field set** on
  any of them, so `fontRegistry.ts` is inferring it. No `typeUseCases` at all.
- `voice` (sliders / neverWords / leanOnWords / rewrites), `values`, `neverList`,
  `naming` (pattern + 5 criteria + examples), `hardRules` (10), `precedence`,
  `guideIntros` (all 7 subtabs), `visibility` (12 section keys).
- **`chop`** — narrative + 5 specs (Color, Position (labels), Footprint,
  Rendering, Content).
- **`labelChassis`** — narrative + 4 elements: Wordmark, Bordered art window,
  Title slot, The chop.
- **No `marks`** key. The guide falls back to `seedCanon.ts`'s mark specs.
- No `agentTechnical` key.

**This matters:** `chop` + `labelChassis` are already a prose description of the
beer-label chassis the target architecture wants as template #1. The design
exists as text; it has never been turned into slots.

### 1.2 What has no editor

`lib/brand/canonSections.ts` maps each guide subtab to the canon keys it may
PATCH. Four keys are owned by **no** section and are preserved verbatim on every
save, meaning **there is no UI anywhere to edit them**:

    naming · chop · labelChassis · visibility

`chop` and `labelChassis` — the two fields most relevant to templates — are
effectively frozen at whatever the seed published.

### 1.3 ⚠️ `brand_labels` was never created

Migration `20260811_brand_labels.sql` is unapplied. Consequences in production
right now:

- `public.brand_labels` does not exist → **`/brand/releases` is broken.**
  `LabelsWorkbench` (321 lines) calls `GET /api/brand/labels`, which 500s.
- `brand_assets.label_id` and `brand_assets.motif_family` **do not exist**
  (verified: `42703 column does not exist`).
- The `label_art` asset kind is gone regardless: migration `20260903` recreated
  the `kind` check constraint from a fresh list and **dropped `label_art`**
  without noting it. Applying `20260811` today would restore `label_art`, then
  `20260903` would remove it again — the two migrations are order-dependent and
  currently inconsistent.

So the entire "per-beer label" layer — story title, subtitle, motif family,
Tier-2 palette, naming check, chop glyph assignment — exists as ~450 lines of
tested code (`lib/brand/labels.ts`, `useLabels.ts`, `LabelsWorkbench.tsx`, two
API routes) with **zero rows and no table**. It is dead weight today, but it is
also the closest thing to a per-beer input record for a label template.

---

## 2. Storage

One bucket, `brand-assets`, **private** (flipped by `20260903`). Contents:

    brand-assets/
      wordmark/6d2f6c5d-894b-42d9-a7e2-e89e6c39d8aa.svg   17,454 bytes

That is the entire brand asset library: one file.

- **Path convention:** `<kind>/<uuid>.<ext>`. Kind is a directory; the filename
  is a fresh UUID (not the row id).
- **Not versioned.** No version column, no version in the path. "Versioning" is
  a status flip: `approveAsset()` archives the prior approved row for the same
  `(kind, variant)` before approving the new one. The old row and its bytes
  survive, so history is recoverable — but there is no version *number*, and
  nothing can say "the file this output shipped with".
- **Serving:** never a public/signed URL. `assetFileUrl(id)` returns a permanent
  origin-relative path `/api/brand/assets/{id}/file`, proxied through a
  session-gated route. This was deliberate (signed URLs expire and break
  `@font-face` and cached RSC payloads) and should be preserved.
- Other buckets: `tax-confirmations`, `payroll-gl-reports` — unrelated.

Asset kinds today: `logo, wordmark, chop_glyph, texture, icon, photo, font,
example`. Declared once in `lib/brand/assets.ts` (`BRAND_ASSET_KINDS`) and
mirrored by hand into the DB check constraint.

---

## 3. UI surfaces

`app/brand/nav-config.ts` declares 3 tabs (~5,100 lines of brand UI total):

| Tab | Route | Gate | State |
|---|---|---|---|
| Brand Guide | `/brand/guide` | `brand.guide:read` | **Mature.** Works. |
| Assets | `/brand/assets` | `brand.assets:read` | Works; 1 asset in it. |
| Releases | `/brand/releases` | `brand.releases:manage` | **Broken** (no table). |

Plus `/brand/preview` — an unlinked palette/role swatch page.

**Brand Guide** is one page with 7 in-page tabs (`BrandGuideTabs.tsx`):
Ethos · Voice · Visual Identity · Color · Type · Marks · Agent Rules, plus a
History tab for admins. Every tab is read-only for all users and gains an
inline **Edit mode** for `brand.guide:manage` (admin-only in practice). Editing
is **section-scoped**: a PATCH from one subtab may only touch that subtab's keys
(`canonSections.ts`), autosaved (`useSectionAutosave.ts`) into the single draft
row, then whole-document published (`canonWorkflow.publishDraft`) with an
auto-generated structured changelog (`diffCanon.ts` → `change_entries`).

**Agent Rules** is the notable one: it does not store content. It *compiles* the
whole canon to Markdown (`lib/brand/markdown.ts`, 225+ lines) and offers it
whole or by section, copyable/downloadable. The AI-hook requirement in the
target architecture is already ~80% built — it just emits Markdown for a human
to paste, not JSON over an endpoint, and it has no season or asset context.

**Reads/writes by surface:**

- Guide view → `getCanon()` (published row, `unstable_cache`, falls back to
  `seedCanon.ts` on any error/empty) + `listAssets()` via the **admin** client.
- Guide edit → `PATCH /api/brand/canon/draft`, `POST /api/brand/canon/publish`,
  `GET /api/brand/canon/versions`.
- Assets → `GET/POST /api/brand/assets`, `PATCH /api/brand/assets/[id]`,
  `GET /api/brand/assets/[id]/file`.
- Releases → `/api/brand/labels` (500s).
- `/api/brand/chrome` → the "apply brand to the internal app" toggle, gated on
  `org.appearance:manage`, stored in `system_settings`.

---

## 4. Cross-section touchpoints

**There are none today.** Nothing in `app/brand/**` or `lib/brand/**` reads a
production, taproom, or finance table, and nothing outside `/brand` reads a
`brand_*` table. The only leak outward is the app-wide theme skin
(`lib/brand/tokens.ts` → `--color-brand-*`), which is styling, not data.

The `brand_labels.motif_family` / `chop_glyph_asset_id` columns were the
intended seam to beers — but the table doesn't exist and, even as designed,
`brand_labels` has **no FK to `recipes`**. A label and a beer are unrelated rows
that happen to share a name.

### The bridge pattern to copy

Square Item Mappings is the established cross-section bridge, and it has a
specific shape worth matching exactly:

- A dedicated **link table** — `recipe_square_links` (111 rows) — joining
  `recipes.id` (production) to `square_catalog_variations` / `square_catalog_items`
  (Square-synced masters), keyed by `packaging`, with denormalized
  `item_name` / `variation_name` alongside the FKs.
- A **single capability reachable from two sections**: `CAP.catalogRead` /
  `catalogOperate` on scope `catalog` — deliberately *not* nested under
  `production.*` or `taproom.*`, with the comment "one scope for a capability
  reachable from two sections, so no route ever has to invent a second gate."
- Prices live on `square_catalog_variations.price_amount` (bigint cents, 424
  rows), never re-entered.

**The menu template's data path already exists end to end:**

    tap_assignments (14 rows, tap_number → recipe_id)
      → recipes (23 rows, beer_name)
      → recipe_square_links (111 rows)
      → square_catalog_variations.price_amount

A menu template needs no new pricing model — only a `brand.*` ↔ `catalog` grant
following the `catalog` precedent.

---

## 5. Conventions to conform to

**Migrations** (`supabase/migrations/`)
- Source of truth for schema. Never hand-edit an applied file; add a new one.
- ⚠️ **Take a full `YYYYMMDDHHMMSS` stamp**, not a plain date. The CLI keys on
  the digits before the first `_`, and a plain `YYYYMMDD` prefix has collided
  with parallel branches twice. Recent files show both styles
  (`20260905_brand_canon_color_expansion.sql` vs `20260906120000_export_transaction_edit.sql`)
  — follow the 14-digit form.
- Every brand migration ends with `-- Human-gated (do not auto-apply).` and opens
  with a prose block explaining *why*, what is idempotent, and what ordering
  constraint it carries. Match that.
- Written to be idempotent (`if not exists`, `on conflict do nothing`,
  re-runnable `update`s).

**RLS**
- Brand tables: `enable row level security`, a narrow `select` policy, and
  **no write policy at all** — writes go through `createSupabaseAdminClient()`
  from route handlers, gated by `requirePermission(CAP.x)`. `brand_assets`'
  anon-select policy was dropped entirely in `20260903`; the whole `/brand` tree
  is session-gated and reads through the admin client.
- ⚠️ `apply_grant_policies` is additive-only — alone it denies every non-`custom`
  role, and a no-policy SELECT returns **zero rows with no error**. Pair it with
  a role policy or use an admin-client route (which is what brand does).

**Auth**
- `lib/auth/scopes.ts` declares scopes with a `section`; `lib/auth/capabilities.ts`
  names intents (`CAP.brandGuideRead`, …). Capability **names are a stable API** —
  212 fixture rows key on them. Re-key the `scope:` coordinate, never the name.
- Routes: `await requirePermission(CAP.x)` in a try/catch that returns the thrown
  Response; pages: `can(session.grants, cap.scope, cap.level)` then `redirect()`.
- Nav entries carry `requires` so a visible tab never leads to a redirect.

**Naming / module layout**
- Tables `brand_<noun>`, snake_case columns, `id uuid default gen_random_uuid()`,
  `status text check (...)`, `created_by uuid`, `created_at/approved_at timestamptz`.
- Business logic in `lib/brand/*.ts`, one concern per file, each with a co-located
  `*.test.ts` (33 of 33 brand modules have one — coverage floor is enforced in
  `vitest.config.ts` and CI).
- The injected-client pattern is universal: every `lib/brand` module takes a
  `SupabaseLikeClient` so tests pass a fake. Follow it.
- Route handlers parse with `requireDateRange()` where applicable and wrap errors
  with `apiError()`.

**UI**
- `app/globals.css` `@theme` tokens + `app/components/ui/` primitives. No raw
  `zinc-*`/hex. `PageHeader` / `Card` / `Modal` / `Banner` / `Badge` / `TabBar` /
  `SubNav`, `.btn-primary`/`.btn-secondary`, `.inp`. Full spec in
  `docs/UI_STANDARD.md`.

**Rendering dependencies — none exist.** `package.json` has no SVG rasterizer, no
PDF writer, no image pipeline (`pdf-parse` is read-only, for QB imports). Every
render capability in the target architecture is a new dependency decision.

---

## 6. Summary for Phase 2

**Keep and build on:**
- `brand_canon_versions` — mature, versioned, diffed, section-scoped-editable.
  This *is* the Foundations layer; it does not need replacing.
- `brand_assets` + the private bucket + the `/api/brand/assets/[id]/file` proxy.
- `lib/brand/markdown.ts` — the AI-context compiler, 80% of the AI hook.
- The `catalog` scope + `recipe_square_links` shape as the bridge template.

**Gaps against the target:**
- No `brand_templates`, `brand_seasons`, `brand_outputs`, `brand_tokens`.
- Assets have **no immutable version** — the "an output must forever point at
  what it shipped with" requirement cannot be met today.
- `chop` / `labelChassis` are prose with no editor and no slot model.
- CMYK/Pantone on core colors only; no clearspace field; no cap-height ratios.
- No render path, no export formats, no constraint validation, no deps for any
  of it.
- **Zero** cross-section data links.

**Must be decided before building:**
1. What to do about the unapplied `20260811` / the `label_art` constraint
   conflict, and whether `brand_labels` becomes the beer-label template's input
   record or is retired in favor of a `brand_outputs` row.
2. Asset versioning: add a `version` column and version-in-path, which changes
   the `(kind, variant)` one-approved invariant.
3. The render toolchain (new dependencies, and whether it runs on Vercel
   functions).

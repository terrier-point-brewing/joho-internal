# Brand & Design System — Phase 1 (Canon Editor + Guide Viewer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the Joho canon editable in-app (draft → live-preview → publish, with version history) and render a data-driven brand guide from the published canon.

**Architecture:** A zod schema becomes the single source of truth for the canon shape (`canon.types.ts` = `z.infer`). `canonWorkflow.ts` implements draft/publish/history over the Phase 0 `brand_canon_versions` table; publish snapshots the draft, archives the prior published row, and `revalidateTag('brand-canon')`. Admin-gated API routes wrap the workflow. A `/brand` area adds a data-driven guide viewer (published canon → `.brand-surface` light/dark) and an admin canon editor with structured Palette/Theme/Type facets, a zod-validated JSON block for text sections, and a client-side live preview via the pure resolver.

**Tech Stack:** Next.js 16, React 19, Tailwind v4, Supabase, zod (new dep), @tanstack/react-query, Vitest.

## Global Constraints

- Builds on Phase 0 (`lib/brand/*`, `brand_canon_versions`, `--color-brand-*`, `BrandStyle`). Do NOT modify the Phase 0 ops tokens `--color-*` or ops chrome. Brand surfaces use `--color-brand-*` + `app/components/brand/*`; the editor's own controls use ops primitives (`.btn-*`, `.inp`, `<Card>`, `<Modal>`) since the editor lives in the dark tool.
- Semantic-token rule stands: "Joho"/"Indigo"/"Marcellus" only inside canon data, never in token names or component code.
- Consumers still bind to roles; the pure resolver (`resolveTokens`, `deriveDarkPalette`) is reused UNCHANGED, including client-side for preview.
- Auth: read published guide = any authenticated user; ALL canon edits (draft/publish) = **admin only** via `requireRole([])` (admin always passes; empty list = admin-only), per `lib/auth.ts`.
- Writes use `createSupabaseAdminClient()` (service role); reads of published canon keep the Phase 0 cookieless cached path.
- New/modified `lib/**` ship co-located `*.test.ts`; keep `lib/**` coverage ≥86%. Pure targets: zod schema parse, `nextVersionLabel`, `canonWorkflow` helpers, `BrandPreview` token→style mapping.
- Migration is **human-gated** (header ends "Human-gated (do not auto-apply)."); do NOT apply.
- Next 16: `revalidateTag(tag, profile)` needs the profile arg (`revalidateTag('brand-canon', 'max')`); route handlers that read cookies/session set `export const dynamic = "force-dynamic"`.
- Verify: `npm run verify` is the per-task DoD.

## File Structure

| File | Responsibility |
|---|---|
| `lib/brand/canon.schema.ts` | zod schema for the canon document (the write-validation contract). |
| `lib/brand/canon.types.ts` | **Modify** → `BrandCanon = z.infer<typeof canonSchema>`; keep `RoleName`/`FontRole` unions. |
| `lib/brand/getCanon.ts` | **Modify** → harden `createCookielessClient` env-missing → seed fallback (Phase 0 M4). |
| `lib/brand/canonWorkflow.ts` | `getDraft`/`saveDraft`/`publishDraft`/`listVersions` + pure `nextVersionLabel`. |
| `lib/query-keys.ts` | **Modify** → add brand-canon query keys. |
| `supabase/migrations/20260809_brand_canon_draft.sql` | `updated_at` + one-draft partial unique index. |
| `app/api/brand/canon/draft/route.ts` | GET (draft) + PUT (save), admin-gated. |
| `app/api/brand/canon/publish/route.ts` | POST publish, admin-gated. |
| `app/api/brand/canon/versions/route.ts` | GET history, admin-gated. |
| `app/brand/layout.tsx`, `app/brand/nav-config.ts`, `app/brand/BrandNav.tsx` | Brand area shell + nav (Guide / Canon / History). |
| `app/brand/guide/page.tsx` | Data-driven guide viewer (published canon, light/dark). |
| `app/brand/canon/page.tsx` | Admin canon editor (facets + preview + publish bar). |
| `app/brand/canon/facets/{PaletteFacet,ThemeFacet,TypeFacet,ContentFacet}.tsx` | Structured facet editors. |
| `app/brand/canon/BrandPreview.tsx` | Client live preview (pure resolver → scoped inline vars). |
| `app/brand/canon/history/page.tsx` | Read-only version list. |
| `app/brand/canon/useCanonEditor.ts` | react-query hooks (draft get/save/publish/versions). |

## Execution Budget

- **Mode:** subagent-driven-development. Locality groups: **G1** `lib/brand` backend (T1,T2) · **G2** migration (T3) · **G3** API (T4) · **G4** shell+guide (T5) · **G5** editor UI (T6,T7). Route each group to ONE `impl` agent sequentially.
- **Spawn cap = 7** (5 groups + 2). STOP and report before exceeding.
- **Token target:** ~300k. Honor per-task `model`.

## Task / Model table

| Task | Deliverable | Model | Group |
|---|---|---|---|
| 1 | zod schema + `z.infer` types + getCanon env-harden | Sonnet | G1 |
| 2 | `canonWorkflow` (+ `nextVersionLabel` TDD) | Sonnet | G1 |
| 3 | draft migration | Haiku | G2 |
| 4 | canon API routes + query-keys | Sonnet | G3 |
| 5 | brand shell + data-driven guide viewer | Sonnet | G4 |
| 6 | canon editor (facets + preview + publish + history + hooks) | Sonnet | G5 |
| 7 | verify + browser check | (controller) | G5 |

---

### Task 1: zod schema + `z.infer` types + getCanon hardening

**Files:** Create `lib/brand/canon.schema.ts`; Modify `lib/brand/canon.types.ts`, `lib/brand/getCanon.ts`; Test `lib/brand/canon.schema.test.ts`.

**Interfaces:**
- Produces: `export const canonSchema` (zod) validating the full Phase 0 `BrandCanon` shape; `export type BrandCanon = z.infer<typeof canonSchema>`; `RoleName`/`FontRole` unions unchanged (schema references them via `z.enum`).

- [ ] **Step 1:** `npm install zod`.
- [ ] **Step 2: Write failing test** `canon.schema.test.ts`: `canonSchema.parse(seedCanon)` succeeds; a malformed doc (drop `mission`) throws; a bad hex in `palette[].hex` throws (schema enforces `#rrggbb`).
- [ ] **Step 3: Run** `npx vitest run lib/brand/canon.schema.test.ts` — Expected: FAIL.
- [ ] **Step 4: Implement** `canon.schema.ts` mirroring `canon.types.ts` (roleMap.light = record of all 13 roles; roleMap.dark = partial; palette hex regex; fonts one per role; naming.criteria length 5). Change `canon.types.ts` so `BrandCanon = z.infer<typeof canonSchema>` (re-export; keep `RoleName`/`FontRole`/`ResolvedTokens`). In `getCanon.ts`, wrap `createCookielessClient` so a missing `NEXT_PUBLIC_SUPABASE_URL`/`ANON_KEY` returns a sentinel that makes `getCanonFrom` fall back to `seedCanon` (never throw).
- [ ] **Step 5: Run** the schema test + `npm run verify` (confirms the whole `lib/brand` still type-checks against the inferred type) — Expected: PASS.
- [ ] **Step 6: Commit** `feat(brand): zod canon schema + inferred types + getCanon env fallback`.

---

### Task 2: `canonWorkflow`

**Files:** Create `lib/brand/canonWorkflow.ts`, `lib/brand/canonWorkflow.test.ts`.

**Interfaces (server; client = supabase admin client):**
- `export function nextVersionLabel(current: string | null): string` — bumps minor: `"1.0"→"1.1"`, `null→"1.0"` (pure, tested).
- `export async function getDraft(c): Promise<BrandCanon>` — the draft row's document; if none, seed from current published (or `seedCanon`) and insert a draft; return it.
- `export async function saveDraft(c, document: unknown): Promise<void>` — `canonSchema.parse`, upsert the single draft row, `updated_at = now()`.
- `export async function publishDraft(c, opts:{versionLabel?:string; changelog?:string}): Promise<{versionLabel:string}>` — parse draft; insert new `published` row (document, versionLabel ?? nextVersionLabel(currentPublished), changelog, published_at=now()); set prior published → `archived`; delete the draft.
- `export async function listVersions(c): Promise<{id,version_label,status,published_at,changelog}[]>` — published+archived, newest first.

- [ ] **Step 1: Write failing test** for `nextVersionLabel`: `null→"1.0"`, `"1.0"→"1.1"`, `"1.9"→"1.10"`.
- [ ] **Step 2: Run** `npx vitest run lib/brand/canonWorkflow.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `canonWorkflow.ts`. Keep `nextVersionLabel` pure and exported. The DB functions take an injected client (same testability pattern as `getCanonFrom`) so a fake client can cover `getDraft` seeding + `saveDraft` validation-throw paths in tests.
- [ ] **Step 4:** Extend the test: `saveDraft` rejects an invalid document (zod throw); `getDraft` returns seed when the fake client reports no rows. Run — Expected: PASS.
- [ ] **Step 5: Commit** `feat(brand): canon draft/publish/history workflow`.

---

### Task 3: Draft migration

**Files:** Create `supabase/migrations/20260809_brand_canon_draft.sql` (next free number at build time if 20260809 taken).

```sql
-- Brand canon draft support: an editable working draft (one at a time) with an
-- updated_at stamp. Builds on 20260808_brand_canon_versions. Human-gated (do not auto-apply).
alter table public.brand_canon_versions
  add column if not exists updated_at timestamptz not null default now();
create unique index if not exists brand_canon_one_draft
  on public.brand_canon_versions ((status)) where status = 'draft';
```

- [ ] **Step 1:** Write the migration.
- [ ] **Step 2:** Confirm header ends "Human-gated (do not auto-apply)."; do NOT apply.
- [ ] **Step 3: Commit** `feat(brand): brand_canon draft column + one-draft index migration`.

---

### Task 4: Canon API routes + query-keys

**Files:** Create `app/api/brand/canon/{draft,publish,versions}/route.ts`; Modify `lib/query-keys.ts`.

Each route: `export const dynamic = "force-dynamic"`; gate with `try { await requireRole([]); } catch (res) { return res as Response; }` (admin only); use `createSupabaseAdminClient()`; call the matching `canonWorkflow` function; wrap failures in `apiError(err)`.
- `draft/route.ts`: `GET` → `getDraft`; `PUT` → `saveDraft(await req.json())` then 200.
- `publish/route.ts`: `POST` → `publishDraft(body)`; returns `{versionLabel}`.
- `versions/route.ts`: `GET` → `listVersions`.

`lib/query-keys.ts`: add `brandCanon: { draft: ['brand','canon','draft'], versions: ['brand','canon','versions'] }`.

- [ ] **Step 1:** Implement the three routes + query-keys entries.
- [ ] **Step 2:** `npm run verify` — Expected: PASS.
- [ ] **Step 3:** Manual gate check note: unauthenticated `requireRole` throws a 401/403 Response (verified in browser step, Task 7).
- [ ] **Step 4: Commit** `feat(brand): admin-gated canon API (draft/publish/versions)`.

---

### Task 5: Brand shell + data-driven guide viewer

**Files:** Create `app/brand/layout.tsx`, `app/brand/nav-config.ts`, `app/brand/BrandNav.tsx`, `app/brand/guide/page.tsx`. (Follow an existing per-area nav, e.g. `app/finance/settings/SettingsNav.tsx` + `layout.tsx`.)

- `nav-config.ts`: tabs Guide (`/brand/guide`), Canon (`/brand/canon`), History (`/brand/canon/history`).
- `BrandNav.tsx` + `layout.tsx`: the tab row + `<main className="px-4 sm:px-6 py-4 sm:py-8">` shell (ops chrome). Gate Canon/History tabs to admin (read session in the layout; hide for non-admin).
- `guide/page.tsx`: server component; `const canon = await getCanon();` render a full-page `.brand-surface` wrapper (Joho light/dark) containing `<ThemeToggle/>` + data-driven sections: hero (wordmark via `font-brand-wordmark` + mission), voice (summary, sliders, never/lean-on), color swatches (map `canon.roleMap`/`palette` → role · hex · ratio, click-to-copy via a small client sub-component), type specimen per font role, naming (pattern + 5 criteria + passing examples), agent rules + precedence. Use `--color-brand-*`/`font-brand-*` utilities only.

- [ ] **Step 1:** Implement shell + nav + guide viewer.
- [ ] **Step 2:** `npm run build && npm run verify` — Expected: PASS.
- [ ] **Step 3: Commit** `feat(brand): brand area shell + data-driven guide viewer`.

---

### Task 6: Canon editor

**Files:** Create `app/brand/canon/page.tsx`, `app/brand/canon/facets/{PaletteFacet,ThemeFacet,TypeFacet,ContentFacet}.tsx`, `app/brand/canon/BrandPreview.tsx`, `app/brand/canon/history/page.tsx`, `app/brand/canon/useCanonEditor.ts`; Test `app/brand/canon/BrandPreview.test.ts` (co-located pure mapping).

**Interfaces:**
- `useCanonEditor.ts`: `useDraft()` (query), `useSaveDraft()` (mutation → invalidate draft), `usePublish()` (mutation → invalidate draft+versions), `useVersions()` (query). Keys from `lib/query-keys.ts`.
- `BrandPreview.tsx`: `export function toScopedVars(tokens: ResolvedTokens, mode:'light'|'dark'): Record<string,string>` (pure, tested) → `{ '--color-brand-canvas': hex, … }` for the chosen mode; the component applies them as inline `style` on a `.brand-surface` wrapper and renders swatches + a type specimen + sample brand buttons, with its own light/dark toggle.

- `page.tsx` (client, admin): loads draft via `useDraft`; holds editable draft in state; facet tabs render the facets; each facet edits its slice of the draft; a shared **publish bar** shows dirty state, Save (→ `useSaveDraft`), version label + changelog inputs, Publish (confirm via `<Modal>`/`ConfirmDialog` → `usePublish`); `<BrandPreview draft={draft}>` in a side pane.
- Facets edit: **Palette** (color rows: name/key/hex `<input type=color>`+text/CMYK/PMS; add/remove), **Theme** (per-role `<select>` of palette keys or raw hex for light; dark = derived value shown + override input + reset-to-derived, using `deriveDarkPalette` for the derived baseline), **Type** (role → `<select>` of the loaded families [Marcellus/Lato/Jost/Noto Serif SC]), **Content** (`<textarea>` JSON of the text sections; parse+`canonSchema` partial validation on blur; inline error).
- `history/page.tsx` (admin): `useVersions` → read-only table (version · published_at · changelog).

- [ ] **Step 1: Write failing test** `BrandPreview.test.ts` for `toScopedVars`: light mode maps `--color-brand-canvas` to the light hex; dark mode to the dark hex; returns all 13 role vars.
- [ ] **Step 2: Run** `npx vitest run app/brand/canon/BrandPreview.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `toScopedVars` + all editor files.
- [ ] **Step 4: Run** the test + `npm run verify` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(brand): canon editor with facets, live preview, publish + history`.

---

### Task 7: Verify + browser check (controller)

- [ ] `npm run build && npm run verify` green.
- [ ] Browser (controller; editor is auth-gated — verify what's reachable; confirm guide viewer renders published canon light/dark and the preview pane reflects draft edits without touching the real app chrome). Screenshots where possible.

## Definition of Done (Phase 1)

- `npm run verify` green; `lib/**` coverage ≥86%; `npm run build` passes.
- Draft → save → preview → publish round-trips; publish revalidates so the guide viewer + `BrandStyle` reflect the new version.
- Guide viewer renders the published canon in Joho light/dark; ops chrome unaffected.
- Migration `20260809_brand_canon_draft.sql` committed, NOT applied (human-gated; PR notes prod apply).
- Editing is admin-only; no `--color-*` ops token or ops-chrome file modified.

## Spec self-review

- **Coverage:** schema/zod → T1; types via z.infer → T1; env-harden (P0 M4) → T1; draft/publish/history workflow → T2; migration → T3; API → T4; guide viewer → T5; editor facets + preview + publish + history + revalidate → T6/T2; browser → T7.
- **Type consistency:** `BrandCanon`/`RoleName`/`FontRole`/`ResolvedTokens` from Phase 0 reused; `canonSchema`/`nextVersionLabel`/`getDraft`/`saveDraft`/`publishDraft`/`listVersions` defined T1–T2, consumed T4/T6; `toScopedVars` defined+consumed T6.
- **Deferred (not gaps):** one-click rollback, self-hosted-font upload, structured (non-JSON) text editing — later phases.

# Brand Guide Phase 0 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Brand Guide's save/publish path reliable and self-documenting, and settle the asset URL shape — so the seven subtab reworks in phases 1–6 build on something that doesn't fail at random.

**Execution Budget:** subagent-driven-development · **Spawn cap = 7** (5 locality groups + 2) · token target ≈ 180k. The executor STOPS and reports before exceeding the spawn cap.

**Architecture:** Three independent moves. (1) Saving becomes *section-scoped* — a PATCH validates only the canon keys the edited subtab owns, so a stale field elsewhere can't block it; whole-document validation moves to publish, where it reports issues grouped by subtab. (2) Every canon list item gains a stable `id`, which lets a pure `diffCanon` generate the changelog automatically at publish time. (3) The `brand-assets` bucket goes private behind a session-gated proxy route, fixing the URL shape before phases 2–5 start depending on it.

**Tech Stack:** Next.js 16 App Router · TypeScript · Zod 4 · TanStack Query · Supabase (Postgres + Storage) · Vitest

## Global Constraints

- **Plan style (repo override):** Per `CLAUDE.md`, tasks specify file maps, interfaces, signatures, acceptance criteria, and test cases — **not full implementation bodies**. Inline code is capped at ~20 lines per task and used only for genuinely non-obvious logic. This deliberately overrides the writing-plans skill's "complete code in every step" rule.
- **Migrations are human-gated.** Subagents write migration files; they NEVER apply them. The orchestrator applies them only after explicit founder approval and a backup. A partial apply looks identical to a full one — verify.
- **Supabase resolves with `{ error }` rather than throwing.** Every query result must be error-checked, selects included. `canonWorkflow.ts` already routes everything through `assertOk()` — keep it that way.
- **Co-located tests required.** New or modified `lib/` modules ship with `*.test.ts` covering pure logic. Don't drop coverage below `vitest.config.ts` floors (lines 86, statements 86).
- **UI tokens:** editor chrome uses app tokens (`bg-surface`, `text-muted`, `.btn-*`, `.inp`). Never raw `zinc-*`/`amber-*`/etc. Guide *views* use brand tokens (`bg-brand-*`) — untouched by this phase.
- **API conventions:** route handlers wrap errors with `apiError()` from `lib/utils/api.ts`; auth via `requirePermission(CAP.*)` from `lib/auth.ts`. No business logic in `app/api/**`.
- **Migration prefixes:** latest existing is `20260901`. This phase uses `20260902` and `20260903`. `scripts/check-migrations.mjs` fails CI on duplicate prefixes.
- **Verify command:** `npm run verify` (lint + typecheck + tests) is the per-task definition of done.

---

## File Structure

**Group A — Schema foundation**
| File | Responsibility |
|---|---|
| `lib/brand/canonSections.ts` *(new)* | The one map from guide subtab → the canon keys it owns, plus the matching `canonSchema.pick()`. Shared by client and server. |
| `lib/brand/canonIds.ts` *(new)* | Pure `withIds()` — backfills stable `id`s on canon list items. |
| `lib/brand/canon.schema.ts` *(modify)* | Add optional `id` to list-item shapes. |

**Group B — Section-scoped save**
| File | Responsibility |
|---|---|
| `lib/brand/canonWorkflow.ts` *(modify)* | Add `saveDraftSection()` and `validateCanonForPublish()`. |
| `app/api/brand/canon/draft/route.ts` *(modify)* | Add `PATCH`. |
| `app/api/brand/canon/publish/route.ts` *(modify)* | Use the validation report. |

**Group C — Changelog**
| File | Responsibility |
|---|---|
| `lib/brand/diffCanon.ts` *(new)* | Pure canon diff → `ChangeEntry[]`, plus `renderChangelog()`. |
| `supabase/migrations/20260902_brand_canon_change_entries.sql` *(new)* | `change_entries jsonb` column. |
| `app/brand/canon/CanonHistory.tsx` *(modify)* | Render structured entries. |

**Group D — Editor client**
| File | Responsibility |
|---|---|
| `app/brand/canon/useCanonEditor.ts` *(modify)* | `usePatchSection()`. |
| `app/brand/canon/CanonEditor.tsx` *(modify)* | Debounced autosave, per-section dirty state, publish preview. |
| `app/brand/canon/BrandPreview.tsx` + `.test.ts` *(delete)* | Removed. |

**Group E — Assets**
| File | Responsibility |
|---|---|
| `app/api/brand/assets/[id]/file/route.ts` *(new)* | Session-gated binary proxy. |
| `lib/brand/assets.ts` *(modify)* | `assetFileUrl()` replaces `publicUrlFor()`. |
| `supabase/migrations/20260903_brand_assets_private.sql` *(new)* | Private bucket, drop anon policies, new kinds, `title`/`alt_text`. |

---

## Task Table

| # | Task | Group | Model |
|---|---|---|---|
| 1 | Section map + stable ids | A | Sonnet |
| 2 | Section-scoped draft PATCH | B | Sonnet |
| 3 | Publish validation report | B | Sonnet |
| 4 | `diffCanon` pure module | C | Sonnet |
| 5 | Changelog persistence + history UI | C | Sonnet |
| 6 | Autosave + per-section dirty state | D | Sonnet |
| 7 | Delete BrandPreview | D | Haiku |
| 8 | Asset proxy route + `assetFileUrl` | E | Sonnet |
| 9 | Private-bucket migration | E | Sonnet |

Suggested grouping for spawns: {1}, {2,3}, {4,5}, {6,7}, {8,9} — five spawns, cap 7.

---

### Task 1: Section map + stable ids

**Files:**
- Create: `lib/brand/canonSections.ts`, `lib/brand/canonSections.test.ts`
- Create: `lib/brand/canonIds.ts`, `lib/brand/canonIds.test.ts`
- Modify: `lib/brand/canon.schema.ts`
- Reference (do not edit yet): `app/brand/canon/facets/canonSlices.ts` — this task supersedes its `keys`/`schema` fields; Task 6 rewires the facets.

**Interfaces:**

- Produces:
```ts
// lib/brand/canonSections.ts
import type { GuideSectionKey } from "./guideIntros";
export const SECTION_KEYS: Record<GuideSectionKey, readonly (keyof BrandCanon)[]>;
export function sectionSchema(section: GuideSectionKey): ZodType;   // canonSchema.pick over SECTION_KEYS[section]
export function sectionOf(key: keyof BrandCanon): GuideSectionKey | null;

// lib/brand/canonIds.ts
export function withIds(canon: BrandCanon): { canon: BrandCanon; changed: boolean };
```

- Consumes: `canonSchema` and `BrandCanon` as they exist today.

**Design notes:**

`SECTION_KEYS` must cover every subtab. Start from today's `canonSlices.ts` and add the keys no subtab currently owns, so nothing is orphaned:

| Section | Keys |
|---|---|
| `ethos` | `values` |
| `voice` | `voice` |
| `visual` | `illustrationLaw` |
| `color` | `palette`, `roleMap`, `usageRatios`, `colorForbidden` |
| `type` | `fonts` |
| `marks` | `marks` |
| `agent` | `neverList`, `precedence`, `hardRules` |

`brandName`, `version`, `naming`, `chop`, `labelChassis`, `visibility`, `guideIntros` belong to no subtab. `guideIntros` is edited by every subtab (each owns its own key) — handle it as a special case in Task 2, not via `SECTION_KEYS`. The rest are untouched by section saves and must be preserved verbatim on PATCH.

`withIds` assigns `crypto.randomUUID()` to any item in `values`, `voice.sliders`, `voice.rewrites`, `palette`, `fonts`, `marks`, and `marks[].variants` that lacks one. It must be **idempotent** and must **never regenerate an existing id** — `diffCanon` correctness depends on ids surviving edits. Do NOT derive ids from content (a retitled value would look like a delete plus an add).

`id` is added to the schema as `z.string().optional()`, not required — a stored document written before this phase must still parse. Task 9's sibling migration is not what backfills these; `getDraft` does, on first read.

- [ ] **Step 1: Write failing tests for `canonSections`**

Cases: every `GuideSectionKey` has a non-empty entry; `sectionSchema("ethos").parse({values: […]})` succeeds; `sectionSchema("ethos").parse({voice: …})` strips or rejects the foreign key; `sectionOf("palette") === "color"`; `sectionOf("naming") === null`; the union of all `SECTION_KEYS` values contains no duplicates (no key owned by two subtabs).

- [ ] **Step 2: Run `npx vitest run lib/brand/canonSections.test.ts` — expect FAIL (module not found)**

- [ ] **Step 3: Implement `canonSections.ts`**

- [ ] **Step 4: Run the test — expect PASS**

- [ ] **Step 5: Write failing tests for `withIds`**

Cases: items with no `id` receive one; a second call returns `changed: false` and identical ids (idempotent); an existing id is preserved; `changed` is `true` only when something was assigned; nested `marks[].variants` are covered; an empty/absent `marks` array doesn't throw.

- [ ] **Step 6: Run — expect FAIL**

- [ ] **Step 7: Add optional `id` to the list-item schemas in `canon.schema.ts`, then implement `canonIds.ts`**

Schemas to touch: the `values` element, `voice.sliders` element, `voice.rewrites` element, `brandColorSchema`, `brandFontSchema`, `markSchema`, `markVariantSchema`.

- [ ] **Step 8: Run both test files — expect PASS**

- [ ] **Step 9: Run `npm run verify` — expect clean**

- [ ] **Step 10: Commit**

```bash
git add lib/brand/canonSections.ts lib/brand/canonSections.test.ts lib/brand/canonIds.ts lib/brand/canonIds.test.ts lib/brand/canon.schema.ts
git commit -m "feat(brand): add section→keys map and stable canon item ids"
```

**Acceptance:** `npm run verify` clean. Every guide subtab maps to at least one canon key. `withIds` is idempotent under repeated application.

---

### Task 2: Section-scoped draft PATCH

**Files:**
- Modify: `lib/brand/canonWorkflow.ts`
- Modify: `lib/brand/canonWorkflow.test.ts`
- Modify: `app/api/brand/canon/draft/route.ts`

**Interfaces:**

- Consumes: `SECTION_KEYS`, `sectionSchema` (Task 1); `withIds` (Task 1); the existing `SupabaseLikeClient`, `getDraftRow`, `assertOk`.
- Produces:
```ts
export async function saveDraftSection(
  client: SupabaseLikeClient,
  section: GuideSectionKey,
  patch: Partial<BrandCanon>,
): Promise<void>;
```

**Design notes:**

This is the task that fixes the headline bug. `saveDraft()` currently runs `canonSchema.parse()` on the whole document, so an invalid `naming.criteria` (must be exactly 5) or a `roleMap.light` missing one of its 13 required roles blocks saving *every* subtab. `saveDraftSection` must validate **only** `sectionSchema(section)` plus, when present, the single `guideIntros[section]` string.

Required behaviour:
1. Reject any key in `patch` that is neither in `SECTION_KEYS[section]` nor `guideIntros` — a section must not be able to write another's fields. Throw a clear error naming the offending key.
2. When `patch.guideIntros` is present, merge only `[section]` from it into the existing `guideIntros`; never replace the whole record.
3. Merge the validated patch into the **stored** draft document (re-read it inside this call — do not trust a client-supplied full document), then write back with `updated_at`.
4. Route the write through `assertOk`, matching the existing functions.
5. Leave `saveDraft()` in place and unchanged — Task 6 stops calling it from the editor, but it stays as the whole-document escape hatch.

`getDraft()` also changes here: apply `withIds()` to the document it's about to return, and when `changed` is true, persist the id-bearing version before returning it. That's what backfills ids on stored rows without a data migration.

- [ ] **Step 1: Write failing tests in `canonWorkflow.test.ts`**

Use the existing fake-client pattern in that file. Cases:
- patching `ethos` with `{ values: [...] }` writes a document where `values` changed and **every other key is byte-identical** to the stored draft
- patching `ethos` succeeds **even when the stored draft has an invalid `naming.criteria` of length 3** — this is the regression test for the headline bug, and it must fail before the implementation exists
- patching `ethos` with `{ voice: … }` throws, naming `voice`
- patching with `{ guideIntros: { ethos: "x" } }` leaves other subtabs' intros intact
- a Supabase `{ error }` on the update surfaces as a thrown error (not a silent success)
- `getDraft` on a document with no ids returns one with ids **and** issues a persist call

- [ ] **Step 2: Run `npx vitest run lib/brand/canonWorkflow.test.ts` — expect FAIL**

- [ ] **Step 3: Implement `saveDraftSection` and the `getDraft` id backfill**

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Add `PATCH` to the draft route**

Same `requirePermission(CAP.brandGuideManage)` gate and `apiError()` wrapper as the existing `GET`/`PUT`. Body: `{ section: GuideSectionKey, patch: Partial<BrandCanon> }`. Validate `section` against `guideSectionSchema` and return 400 on a bad value. Respond `{ ok: true }`.

- [ ] **Step 6: Run `npm run verify` — expect clean**

- [ ] **Step 7: Commit**

```bash
git add lib/brand/canonWorkflow.ts lib/brand/canonWorkflow.test.ts app/api/brand/canon/draft/route.ts
git commit -m "feat(brand): section-scoped canon draft PATCH"
```

**Acceptance:** The "patch ethos while `naming` is invalid" test passes. A cross-section write throws. No test asserts a successful write that didn't happen.

---

### Task 3: Publish validation report

**Files:**
- Modify: `lib/brand/canonWorkflow.ts`, `lib/brand/canonWorkflow.test.ts`
- Modify: `app/api/brand/canon/publish/route.ts`

**Interfaces:**

- Consumes: `sectionOf` (Task 1), `canonSchema`.
- Produces:
```ts
export interface PublishIssue {
  section: GuideSectionKey | "other";
  path: string;      // "naming.criteria"
  message: string;   // "Array must contain exactly 5 element(s)"
}
export type PublishValidation =
  | { ok: true; canon: BrandCanon }
  | { ok: false; issues: PublishIssue[] };

export function validateCanonForPublish(doc: unknown): PublishValidation;
```

**Design notes:**

Whole-document `canonSchema.parse` belongs here and nowhere else. Map each Zod issue to a subtab by taking `issue.path[0]` and running it through `sectionOf`; unmapped keys (`naming`, `visibility`, …) get `section: "other"`.

`publishDraft` calls this instead of its bare `canonSchema.parse(draft.document)`. On failure it throws an error whose message is a readable, subtab-grouped summary — the API surfaces it through the existing `apiError()`, and the client renders it. Response shape on failure stays `{ error: string }`; no new contract.

- [ ] **Step 1: Write failing tests**

Cases: a valid canon returns `{ ok: true }` with the parsed document; a canon with a 3-element `naming.criteria` returns `ok: false` with one issue at `path: "naming.criteria"`, `section: "other"`; a canon missing a `roleMap.light` role maps to `section: "color"`; multiple independent breakages produce multiple issues rather than stopping at the first; `publishDraft` on an invalid draft throws and — critically — does **not** insert a published row or archive the prior one.

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `validateCanonForPublish`; wire it into `publishDraft`**

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Run `npm run verify` — expect clean**

- [ ] **Step 6: Commit**

```bash
git add lib/brand/canonWorkflow.ts lib/brand/canonWorkflow.test.ts app/api/brand/canon/publish/route.ts
git commit -m "feat(brand): subtab-grouped publish validation report"
```

**Acceptance:** An invalid canon cannot publish, and the failure names the subtab to fix. No partial publish (archive-without-insert) on validation failure.

---

### Task 4: `diffCanon` pure module

**Files:**
- Create: `lib/brand/diffCanon.ts`, `lib/brand/diffCanon.test.ts`

**Interfaces:**

- Consumes: `SECTION_KEYS`/`sectionOf` (Task 1), stable ids (Task 1).
- Produces:
```ts
export interface ChangeEntry {
  section: GuideSectionKey | "other";
  kind: "added" | "removed" | "changed";
  label: string;              // "Seal Red hex #ad1a2d → #a51829"
  path: string;               // "palette.seal-red.hex"
  before?: string;
  after?: string;
}
export function diffCanon(prev: BrandCanon | null, next: BrandCanon): ChangeEntry[];
export function renderChangelog(entries: ChangeEntry[]): string;   // markdown, grouped by section
```

**Design notes:**

This is the only genuinely non-obvious logic in the phase, so here is the matching rule in full:

```ts
// List items are matched by `id`, NEVER by array index.
//   in next, not in prev  → added
//   in prev, not in next  → removed
//   in both, fields differ → changed (one entry per differing field)
// Order-only changes produce NO entries — reordering is not a content change.
// prev === null (first publish) → one "added" entry per section, not per field.
```

Everything else is a straightforward recursive compare over `SECTION_KEYS`.

Labels must be human sentences, not paths. Prefer the item's own display field for identity: `name` for palette colors, `title` for values and marks, `family` for fonts, `left`/`right` for sliders, `context` for rewrites. Fall back to the id only when no display field exists.

`renderChangelog` groups by section under `##` headings and emits one bullet per entry. Deterministic ordering — sort sections by `GUIDE_SECTIONS` order, entries by path — so the same diff always renders identically.

- [ ] **Step 1: Write failing tests**

Cases: changing one palette hex yields exactly one entry with `section: "color"` and both `before`/`after`; **reordering `values` yields zero entries** (the key regression this module exists to prevent); adding a value yields one `added`; removing yields one `removed`; renaming a value's title yields `changed`, not add+remove; an unchanged canon yields `[]`; `prev: null` yields one entry per populated section; `renderChangelog([])` returns an empty string; `renderChangelog` output is stable across two calls with the same input.

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `diffCanon.ts`**

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Run `npm run verify` — expect clean**

- [ ] **Step 6: Commit**

```bash
git add lib/brand/diffCanon.ts lib/brand/diffCanon.test.ts
git commit -m "feat(brand): pure canon diff for auto-generated changelogs"
```

**Acceptance:** Reordering a list produces zero entries. Every entry names a subtab. Output is deterministic.

---

### Task 5: Changelog persistence + history UI

**Files:**
- Create: `supabase/migrations/20260902_brand_canon_change_entries.sql`
- Modify: `lib/brand/canonWorkflow.ts`, `lib/brand/canonWorkflow.test.ts`
- Modify: `app/brand/canon/useCanonEditor.ts` (extend `VersionRow`)
- Modify: `app/brand/canon/CanonHistory.tsx`
- Modify: `app/api/brand/canon/versions/route.ts` (select the new column)

**Interfaces:**

- Consumes: `diffCanon`, `renderChangelog` (Task 4).
- Produces: `VersionRow` gains `change_entries: ChangeEntry[] | null`.
- `publishDraft(client, opts)` — `opts.changelog` is now an **optional founder note appended to** the generated changelog, not a replacement for it.

**Migration** (`20260902`) — header must carry the repo's standard `-- Human-gated (do not auto-apply).` line:

```sql
alter table public.brand_canon_versions
  add column if not exists change_entries jsonb;
```

**Design notes:**

`publishDraft` diffs the draft against the currently published row *before* archiving it, then writes both `change_entries` (structured) and `changelog` (rendered markdown + any founder note). When there is no prior published row, `prev` is `null`.

`CanonHistory` renders entries grouped by subtab in an expandable row. Keep the existing `Card`/`Badge` primitives and app tokens; the flat `changelog` text remains the collapsed summary. **Do not** hand-roll a disclosure control — use a `<details>` element or the existing pattern in the codebase.

- [ ] **Step 1: Write failing tests in `canonWorkflow.test.ts`**

Cases: publishing with a changed palette writes a non-empty `change_entries` array and a `changelog` containing the color name; publishing with a founder note includes **both** the generated text and the note; publishing the very first version (no prior published row) succeeds with `prev: null`; the diff is computed against the pre-archive published document, not the post-archive state.

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Write the migration file. Do NOT apply it.**

- [ ] **Step 4: Implement the `publishDraft` changes; extend `listVersions` and the versions route to select `change_entries`**

- [ ] **Step 5: Run — expect PASS**

- [ ] **Step 6: Update `CanonHistory.tsx` to render grouped entries**

- [ ] **Step 7: Run `npm run verify` — expect clean**

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/20260902_brand_canon_change_entries.sql lib/brand/canonWorkflow.ts lib/brand/canonWorkflow.test.ts app/brand/canon/useCanonEditor.ts app/brand/canon/CanonHistory.tsx app/api/brand/canon/versions/route.ts
git commit -m "feat(brand): auto-generated changelog on publish"
```

**Acceptance:** Publishing generates a changelog with no typing. The founder note is additive. Migration file written, **not applied** — flag it to the orchestrator.

---

### Task 6: Autosave + per-section dirty state

**Files:**
- Modify: `app/brand/canon/useCanonEditor.ts`
- Modify: `app/brand/canon/CanonEditor.tsx`
- Modify: `app/brand/canon/facets/canonSlices.ts` (re-export from `canonSections.ts`; drop the duplicated `keys`/`schema`)

**Interfaces:**

- Consumes: the `PATCH` route (Task 2), `SECTION_KEYS` (Task 1), `diffCanon` (Task 4).
- Produces:
```ts
export function usePatchSection(): UseMutationResult<
  { ok: true }, Error, { section: GuideSectionKey; patch: Partial<BrandCanon> }
>;
```

**Design notes:**

Replace the single whole-document `Save` with debounced per-section autosave:

- debounce **800 ms** after the last edit; also flush on subtab switch and on window blur
- send only `SECTION_KEYS[section]` (plus this section's `guideIntros` entry) — never the whole document
- keep `Save` as a manual flush button, enabled only when the active section is dirty
- surface state per section: `idle` / `saving` / `saved` / `error`, using the existing `SaveHint` component and `Banner` for errors

The existing re-seed guard at `CanonEditor.tsx:56` (`serverDraft !== seededFrom && !saveDraft.isPending && !dirty`) exists to stop a background refetch clobbering in-progress edits. Autosave makes that race more frequent, not less — **preserve the guard's intent**. `dirty` becomes per-section; re-seed only sections that are not dirty and have no save in flight.

The publish bar gains a changed-sections summary: run `diffCanon(publishedCanon, draft)` client-side and list the affected subtabs, and show `renderChangelog()` output in the `ConfirmDialog` before publishing. This requires the published canon client-side — add it as a prop from the server page rather than a second fetch.

**Do not** invalidate the whole draft query on every autosave success; that refetch is what races the guard. Update the cache in place.

- [ ] **Step 1: Add `usePatchSection` to `useCanonEditor.ts`**

Mirror the existing `request<T>` helper and mutation style. `onSuccess` updates the `brandCanon.draft()` cache entry in place via `setQueryData` — no `invalidateQueries`.

- [ ] **Step 2: Rewire `canonSlices.ts` to source `keys`/`schema` from `canonSections.ts`**

Keep `title`/`description` (UI copy) local; delete the duplicated key lists so there is one source of truth.

- [ ] **Step 3: Implement per-section dirty tracking and the debounced autosave in `CanonEditor.tsx`**

- [ ] **Step 4: Implement the publish-bar changed-sections summary and the confirm-dialog changelog preview**

- [ ] **Step 5: Run `npm run verify` — expect clean**

- [ ] **Step 6: Manual verification in the browser** — this task is not done on a green build alone:
  - edit Ethos, wait 1s, confirm the saved indicator appears without clicking Save
  - switch subtabs mid-edit and confirm the pending edit flushes rather than being lost
  - confirm the publish bar lists exactly the subtabs you changed
  - confirm the confirm-dialog shows the generated changelog

- [ ] **Step 7: Commit**

```bash
git add app/brand/canon/useCanonEditor.ts app/brand/canon/CanonEditor.tsx app/brand/canon/facets/canonSlices.ts
git commit -m "feat(brand): per-section autosave and changed-section publish summary"
```

**Acceptance:** An edit persists without pressing Save. Switching subtabs never loses an edit. One source of truth for section→keys.

---

### Task 7: Delete BrandPreview

**Files:**
- Delete: `app/brand/canon/BrandPreview.tsx`, `app/brand/canon/BrandPreview.test.ts`
- Modify: `app/brand/canon/CanonEditor.tsx`

**Design notes:**

Purely mechanical. Remove the import, the `<BrandPreview draft={draft} />` render, and the two-column wrapper that existed only to host it (`CanonEditor.tsx:130` — the `section === "marks" ? "" : "grid gap-4 lg:grid-cols-[1fr_20rem]"` conditional). Every section now gets full width, so the conditional disappears entirely rather than being inverted.

Check for other importers before deleting — `toScopedVars` is exported from `BrandPreview.tsx` and may be used elsewhere. If it is, move it to `lib/brand/tokens.ts` rather than deleting it. If it isn't, delete it with the file.

- [ ] **Step 1: Run `grep -rn "BrandPreview\|toScopedVars" --include='*.ts' --include='*.tsx' app lib` and record every hit**

- [ ] **Step 2: If `toScopedVars` has importers outside `BrandPreview.tsx`, move it to `lib/brand/tokens.ts` with its test; otherwise skip**

- [ ] **Step 3: Delete the two files and remove the usage + wrapper from `CanonEditor.tsx`**

- [ ] **Step 4: Run `npm run verify` — expect clean, with no unused-import or missing-module errors**

- [ ] **Step 5: Commit**

```bash
git add -A app/brand/canon lib/brand
git commit -m "refactor(brand): remove the Live Preview card from the canon editor"
```

**Acceptance:** No references to `BrandPreview` remain. Editors render full width on every subtab. Coverage does not drop below the `vitest.config.ts` floor — if deleting the test drops it, that is a signal to check the floor, not to restore the file.

---

### Task 8: Asset proxy route + `assetFileUrl`

**Files:**
- Create: `app/api/brand/assets/[id]/file/route.ts`
- Modify: `lib/brand/assets.ts`, `lib/brand/assets.test.ts`
- Modify: `app/brand/guide/MarksEditor.tsx:160`, `app/brand/assets/AssetsView.tsx:140`, `app/brand/releases/LabelsWorkbench.tsx:307`
- Modify: `app/brand/guide/page.tsx` (delete `createCookielessAssetClient`)

**Interfaces:**

- Produces:
```ts
export function assetFileUrl(id: string): string;   // `/api/brand/assets/${id}/file`
```
- Removes: `publicUrlFor(path)`. `resolveAsset` now returns the proxied URL.

**Design notes:**

Route: `GET /api/brand/assets/[id]/file`, gated on `CAP.brandAssetsRead`. Look up the row, download the object from the `brand-assets` bucket with the admin client, and stream it back with the row's MIME type from `file_meta.mime` (fall back to a type derived from `format`). Return 404 for a missing row or missing object.

This is a Next 16 dynamic route — `params` is a Promise and must be awaited. Check `docs/nextjs16-deltas.md` before writing the signature.

Set `Cache-Control: private, max-age=3600`. `private` matters: these are session-gated bytes and must not land in a shared cache.

`app/brand/guide/page.tsx` currently builds a cookieless anon Supabase client solely to read approved assets. With the bucket private that client is both broken and unnecessary — the whole `/brand` tree is already session-gated by `app/brand/layout.tsx`. Delete it and read through the admin client.

The route works against a public bucket too, so this task is verifiable **before** Task 9's migration is applied. Do it in that order.

- [ ] **Step 1: Update `assets.test.ts` for `assetFileUrl`**

Cases: `assetFileUrl("abc")` returns `/api/brand/assets/abc/file`; it does not read `NEXT_PUBLIC_SUPABASE_URL` (the URL is origin-relative by design); `resolveAsset` returns the proxied URL for an approved row and `null` when none is approved. Update the existing `publicUrlFor` assertions rather than leaving them.

- [ ] **Step 2: Run `npx vitest run lib/brand/assets.test.ts` — expect FAIL**

- [ ] **Step 3: Implement `assetFileUrl`, remove `publicUrlFor`, update `resolveAsset`**

- [ ] **Step 4: Create the proxy route**

- [ ] **Step 5: Update the three `<img src>` call sites and delete `createCookielessAssetClient`**

- [ ] **Step 6: Run `npm run verify` — expect clean**

- [ ] **Step 7: Manual verification** — load `/brand/assets` and confirm thumbnails still render (bucket is still public at this point, so a failure here is a route bug, not a permissions one)

- [ ] **Step 8: Commit**

```bash
git add app/api/brand/assets lib/brand/assets.ts lib/brand/assets.test.ts app/brand/guide/MarksEditor.tsx app/brand/assets/AssetsView.tsx app/brand/releases/LabelsWorkbench.tsx app/brand/guide/page.tsx
git commit -m "feat(brand): serve brand assets through a session-gated proxy route"
```

**Acceptance:** No `storage/v1/object/public` URL is constructed anywhere. Asset images render. `grep -rn "publicUrlFor"` returns nothing.

---

### Task 9: Private-bucket migration

**Files:**
- Create: `supabase/migrations/20260903_brand_assets_private.sql`
- Modify: `lib/brand/assets.ts` (extend `BRAND_ASSET_KINDS`)
- Modify: `lib/brand/assets.test.ts`

**Design notes:**

The migration does four things. Header must carry `-- Human-gated (do not auto-apply).`

1. `update storage.buckets set public = false where id = 'brand-assets';`
2. Drop the anon read policy on the table: `drop policy if exists brand_assets_read_approved on public.brand_assets;` — nothing anonymous reads brand assets now that the guide is session-gated.
3. Extend the kind check constraint to add `'font'` and `'example'`. A `check` constraint cannot be altered in place — drop and recreate it, and name it explicitly so the drop is deterministic.
4. `add column if not exists title text` and `add column if not exists alt_text text`.

`BRAND_ASSET_KINDS` in `lib/brand/assets.ts` is documented as mirroring this constraint — extend it in the same commit so the two can't drift.

**This migration is human-gated. Write the file; do not apply it. Report to the orchestrator that it is pending.** Applying it before Task 8 is deployed would break every asset image in the app.

- [ ] **Step 1: Write the migration file**

- [ ] **Step 2: Extend `BRAND_ASSET_KINDS` with `"font"` and `"example"`, and update the test that asserts the kind list**

- [ ] **Step 3: Run `node scripts/check-migrations.mjs` — expect no duplicate-prefix failure**

- [ ] **Step 4: Run `npm run verify` — expect clean**

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260903_brand_assets_private.sql lib/brand/assets.ts lib/brand/assets.test.ts
git commit -m "feat(brand): private asset bucket, font/example kinds, asset titles"
```

- [ ] **Step 6: Report both pending migrations to the orchestrator — do not apply**

**Acceptance:** Migration file written and prefix-checked. `BRAND_ASSET_KINDS` matches the new constraint exactly. Nothing applied.

---

## Post-Phase Verification (orchestrator, after migrations are applied)

Migrations `20260902` and `20260903` are applied by the founder after a backup. Then, **in a browser** — a green `npm run verify` does not cover any of this:

- [ ] Edit each of the seven subtabs; confirm autosave persists without pressing Save
- [ ] Deliberately break one subtab's data and confirm the *other six* still save (the headline regression)
- [ ] Publish; confirm the changelog was generated without typing, and that History shows it grouped by subtab
- [ ] Confirm the guide View reflects the publish **without a manual hard reload** — this is the §4.6 open question. Record the answer: if View is now correct, the Server Action + `updateTag()` change is unnecessary and should be dropped from the plan
- [ ] Confirm asset images still render after the bucket is private, and that an unauthenticated request to `/api/brand/assets/<id>/file` is rejected
- [ ] Confirm `change_entries` is populated on the new published row

---

## Self-Review

**Spec coverage** — phase 0 scope from the proposal, mapped to tasks:

| Proposal item | Task |
|---|---|
| Stable `id`s (§1.3) | 1 |
| `canonSections.ts` (§4.1) | 1, 6 |
| Section-scoped PATCH (§4.1) | 2 |
| Publish validation report (§4.2) | 3 |
| Autosave (§4.3) | 6 |
| Changed-sections publish bar (§4.4) | 6 |
| `diffCanon` + `change_entries` (§4.5) | 4, 5 |
| Delete `BrandPreview` (§4.7) | 7 |
| Private bucket + proxy route (§5.1) | 8, 9 |
| Asset kinds `font`/`example` (§5) | 9 |
| Asset `title`/`alt_text` (§5) | 9 |

No gaps. The §4.6 refresh question is deliberately *not* implemented — it is a measurement in Post-Phase Verification, per the proposal's open item 1.

**Out of scope, confirmed:** all seven subtab redesigns (phases 1–6), the palette expansion and symmetric `roleMap.dark` (phase 3), canon-driven font emission (phase 5).

**Type consistency:** `GuideSectionKey` is used throughout and imported from `lib/brand/guideIntros.ts` (its existing home) — not redefined. `ChangeEntry` is defined once in Task 4 and consumed unchanged in Task 5. `SECTION_KEYS`/`sectionSchema`/`sectionOf` keep the same names in Tasks 1, 2, 3 and 6. `assetFileUrl` replaces `publicUrlFor` in one place (Task 8) and is not referenced before it exists.

**Known risk:** Task 6 changes cache invalidation around a pre-existing re-seed race. The guard at `CanonEditor.tsx:56` documents a real bug it was written to fix — the task preserves its intent rather than removing it, and the manual mid-edit subtab-switch check exists specifically to catch a regression there.

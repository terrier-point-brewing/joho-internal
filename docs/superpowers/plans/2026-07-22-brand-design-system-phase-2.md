# Brand & Design System — Phase 2 (Asset Library) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Store, approve, and resolve brand assets (logo/wordmark/chop_glyph/texture/icon/photo) via a public Supabase Storage bucket + `brand_assets` table, an admin asset-library UI, and a `resolveAsset` used by the guide viewer's wordmark.

**Architecture:** A `brand_assets` table (one approved row per kind+variant) + a public `brand-assets` bucket. `lib/brand/assets.ts` uploads via an injected storage client (same pattern as `lib/tax/files.ts`) and resolves the approved asset's public URL. Admin API routes wrap it; an Assets tab in the brand area manages uploads/approval; the guide viewer renders an approved wordmark asset when present, else the interim text wordmark.

**Tech Stack:** Next.js 16, React 19, Supabase (Postgres + Storage), @tanstack/react-query, Vitest.

## Global Constraints

- Builds on merged Phase 0 + 1. Do NOT modify ops `--color-*` tokens or ops chrome. Reuse the resolver + brand primitives.
- Admin-gate ALL asset writes (upload/approve/archive) via `requireRole([])`. Reads of approved assets are open (public bucket + `status='approved'` RLS).
- Storage upload pattern: mirror `lib/tax/files.ts` — an injected `sb` client with `.storage.from(bucket).upload(path, file)`; keep functions testable with a stub client. Multipart route pattern: mirror `app/api/tax/tasks/[id]/files/route.ts`.
- New/modified `lib/**` ship co-located `*.test.ts`; keep `lib/**` coverage ≥86%. Pure targets: `publicUrlFor`, and the `resolveAsset`/`approveAsset` logic (archive-before-approve, one-approved invariant) via injected fake client.
- Migration is **human-gated** (header ends "Human-gated (do not auto-apply)."); do NOT apply.
- Next 16: route handlers reading session/formData set `export const dynamic = "force-dynamic"`.
- Verify: `npm run verify` is the per-task DoD.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20260810_brand_assets.sql` | `brand_assets` table + `brand-assets` bucket + RLS. |
| `lib/brand/assets.ts` | `publicUrlFor`, `resolveAsset`, `listAssets`, `createAsset`, `approveAsset`, `archiveAsset` + types. |
| `lib/brand/assets.test.ts` | Unit tests (pure URL + workflow via fake client). |
| `lib/query-keys.ts` | **Modify** → add `brandAssets` keys. |
| `app/api/brand/assets/route.ts` | GET list + POST upload (multipart), admin-gated. |
| `app/api/brand/assets/[id]/route.ts` | PATCH `{action:'approve'\|'archive'}`, admin-gated. |
| `app/brand/nav-config.ts` | **Modify** → add the Assets tab (adminOnly). |
| `app/brand/assets/page.tsx` | Admin asset library (grid + upload + approve/archive). |
| `app/brand/assets/useAssets.ts` | react-query hooks. |
| `app/brand/guide/page.tsx` | **Modify** → wordmark via `resolveAsset`, fallback to text. |

## Execution Budget

- **Mode:** subagent-driven. Groups: **G1** `lib/brand` + migration (T1,T2) · **G2** API (T3) · **G3** UI (T4,T5). Spawn cap = 5 (3 groups + 2).
- **Token target:** ~200k. Honor per-task `model`.

## Task / Model table

| Task | Deliverable | Model | Group |
|---|---|---|---|
| 1 | `brand_assets` migration (table + bucket + RLS) | Haiku | G1 |
| 2 | `lib/brand/assets.ts` (+ tests) | Sonnet | G1 |
| 3 | asset API routes + query-keys | Sonnet | G2 |
| 4 | Assets nav tab + asset library UI + hooks | Sonnet | G3 |
| 5 | guide wordmark via resolveAsset | Sonnet | G3 |
| 6 | verify + browser (controller) | (controller) | — |

---

### Task 1: `brand_assets` migration

**Files:** Create `supabase/migrations/20260810_brand_assets.sql` (next free number if taken).

Use the DDL from the spec's "Schema + storage" section verbatim: table with `kind` check constraint (logo/wordmark/chop_glyph/texture/icon/photo), `variant` default 'default', `storage_path`, `format`, `file_meta jsonb`, `status` check (draft/approved/archived), audit columns; a partial unique index `brand_assets_one_approved on (kind, variant) where status='approved'`; enable RLS + `brand_assets_read_approved` select policy (`status='approved'`); `insert into storage.buckets (id,name,public) values ('brand-assets','brand-assets',true) on conflict do nothing`. Header ends "Human-gated (do not auto-apply)."

- [ ] **Step 1:** Write the migration.
- [ ] **Step 2:** Confirm header + do NOT apply.
- [ ] **Step 3: Commit** `feat(brand): brand_assets table + storage bucket migration`.

---

### Task 2: `lib/brand/assets.ts`

**Files:** Create `lib/brand/assets.ts`, `lib/brand/assets.test.ts`.

**Interfaces:**
- `export type BrandAssetKind = "logo"|"wordmark"|"chop_glyph"|"texture"|"icon"|"photo"`.
- `export interface BrandAsset { id:string; kind:BrandAssetKind; variant:string; storage_path:string; format:string; file_meta:Record<string,unknown>; status:"draft"|"approved"|"archived"; }`
- `export function publicUrlFor(path: string): string` — `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/brand-assets/${path}` (pure, tested).
- `export async function resolveAsset(client, { kind, variant='default' }): Promise<string|null>` — approved row's `publicUrlFor(storage_path)` or null.
- `export async function listAssets(client, filter?:{kind?:BrandAssetKind}): Promise<BrandAsset[]>`.
- `export async function createAsset(client, row:{kind,variant,storage_path,format,file_meta}): Promise<BrandAsset>` (status 'draft').
- `export async function approveAsset(client, id): Promise<void>` — archive any current approved for the SAME (kind,variant) FIRST, then set this row approved+approved_at (mirrors Phase 1 publishDraft archive-before-write; the one-approved index forbids two).
- `export async function archiveAsset(client, id): Promise<void>`.
- Injected-client interface models `.from(...).select().eq()/.in()/.order()`, `.insert()`, `.update().eq()` — same testability approach as `canonWorkflow.ts`. (Uploading the binary lives in the API route via `sb.storage`, not here — these functions operate on the table.)

- [ ] **Step 1: Write failing test:** `publicUrlFor("logo/x.svg")` contains `/storage/v1/object/public/brand-assets/logo/x.svg`; `resolveAsset` returns the URL for an approved row and null when only a draft exists; `approveAsset` archives the prior approved of the same kind+variant before approving the new one (fake client enforces one-approved on the approved-count, like Phase 1's fake enforced one-published).
- [ ] **Step 2: Run** `npx vitest run lib/brand/assets.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `assets.ts`.
- [ ] **Step 4: Run** + `npm run verify` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(brand): asset resolve + approve/archive workflow`.

---

### Task 3: Asset API routes + query-keys

**Files:** Create `app/api/brand/assets/route.ts`, `app/api/brand/assets/[id]/route.ts`; Modify `lib/query-keys.ts`.

- Both routes: `export const dynamic = "force-dynamic"`; admin-gate via `try { await requireRole([]); } catch (res) { return res as Response; }`; `createSupabaseAdminClient()`; `apiError` wrapping.
- `route.ts` `GET` → `listAssets` (optional `?kind=`). `POST` → read `await req.formData()`; get `file` (Blob), `kind`, `variant`; upload to bucket via `admin.storage.from("brand-assets").upload(storagePath, file)` (see `lib/tax/files.ts:50` for the exact call shape + error handling), where `storagePath = \`${kind}/${crypto.randomUUID()}.${ext}\``; then `createAsset(...)` with derived `format`/`file_meta` ({bytes, mime}); return the row.
- `[id]/route.ts` `PATCH` → body `{action}` → `approveAsset`/`archiveAsset`.
- `lib/query-keys.ts`: `brandAssets: { all:()=>["brand","assets"], list:(kind?)=>["brand","assets","list",kind??"all"] }`.

- [ ] **Step 1:** Implement both routes + query-keys.
- [ ] **Step 2:** `npm run verify` — Expected: PASS.
- [ ] **Step 3: Commit** `feat(brand): admin-gated asset API (list/upload/approve/archive)`.

---

### Task 4: Assets nav tab + asset library UI

**Files:** Modify `app/brand/nav-config.ts`; Create `app/brand/assets/page.tsx`, `app/brand/assets/useAssets.ts`.

- `nav-config.ts`: add `{ href: "/brand/assets", label: "Assets", adminOnly: true }` to `BRAND_TABS`.
- `useAssets.ts`: `useAssets(kind?)` (query), `useUploadAsset()` (mutation, posts `FormData` → invalidate list), `useApproveAsset()`, `useArchiveAsset()` (PATCH → invalidate). Keys from `lib/query-keys.ts`.
- `page.tsx` (client, admin, ops chrome): asset grid grouped by kind — each card shows the thumbnail (`<img src={publicUrl}>` via the API-returned row; compute URL client-side with a small `publicUrlFor` import or return it from the API), variant, `<Badge>` status, and approve/archive actions (ops `.btn-*`). An upload form (file `<input type=file>` + kind `<select>` + variant `<input>`) using ops primitives. Reuse `<Card>`/`<Badge>`; no hand-rolled primitives.

- [ ] **Step 1:** Implement nav entry + hooks + page.
- [ ] **Step 2:** `npm run build && npm run verify` — Expected: PASS.
- [ ] **Step 3: Commit** `feat(brand): asset library UI + Assets tab`.

---

### Task 5: Guide wordmark via resolveAsset

**Files:** Modify `app/brand/guide/page.tsx`.

In the guide's hero, call `resolveAsset(cookielessClient, { kind:"wordmark" })` (server; reuse the same cookieless/cached read approach as `getCanon` — if a shared cookieless client helper isn't exported, read via the anon client the same way). If a URL is returned, render `<img src={url} alt={canon.brandName} className="...">` inside the `.brand-surface`; otherwise fall back to the existing `font-brand-wordmark` text. Keep it a server component.

- [ ] **Step 1:** Implement the wordmark swap with fallback.
- [ ] **Step 2:** `npm run build && npm run verify` — Expected: PASS.
- [ ] **Step 3: Commit** `feat(brand): guide wordmark uses approved asset when present`.

---

### Task 6: Verify + browser (controller)

- [ ] `npm run build && npm run verify` green.
- [ ] Browser: confirm brand routes compile/redirect cleanly (auth-gated; authenticated E2E needs user creds). Confirm no server errors.

## Definition of Done (Phase 2)

- `npm run verify` green; `lib/**` ≥86%; build passes.
- Migration `20260810_brand_assets.sql` committed, NOT applied (human-gated; PR notes prod apply + bucket creation).
- Asset upload/approve/archive round-trips through the admin API; `resolveAsset` returns approved public URLs; guide wordmark uses an approved asset when present, else text.
- Admin-only writes; no ops `--color-*` / ops-chrome modification.

## Spec self-review

- **Coverage:** table+bucket → T1; resolve/approve/list/upload logic → T2; API+upload → T3; library UI+nav → T4; wordmark payoff → T5; verify → T6.
- **Type consistency:** `BrandAsset`/`BrandAssetKind`/`publicUrlFor`/`resolveAsset`/`approveAsset` defined T2, consumed T3/T4/T5; `brandAssets` keys T3 → T4.
- **Deferred (not gaps):** `label_id`/`source`/`generator_meta` columns, generated artifacts, self-hosted fonts, image resizing — later phases.

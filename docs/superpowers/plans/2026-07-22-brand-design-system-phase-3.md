# Brand & Design System — Phase 3 (Labels + Tier-2 Palettes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps.

**Goal:** Model beers as labels (story title/subtitle/motif, Tier-2 palette, 5-criteria naming check, chop glyph), with an admin editor and a guide "Tap list".

**Architecture:** `brand_labels` table + `brand_assets` extension (`label_id`, `motif_family`, `label_art` kind). `lib/brand/labels.ts` (injected-client testable CRUD + `syncNamingCheck`). Admin API. `/brand/labels` editor. Guide gains a Tap-list from approved labels.

**Tech Stack:** Next.js 16, React 19, Supabase, react-query, Vitest.

## Global Constraints

- Builds on merged Phases 0–2. No ops `--color-*` / ops-chrome changes. Reuse resolver + brand primitives + the Phase 2 asset API for the chop picker.
- Admin-gate all label writes via `requireRole([])`; approved reads open (RLS `status='approved'`).
- Injected-client testability pattern (see `lib/brand/canonWorkflow.ts` / `lib/brand/assets.ts`); co-located `*.test.ts`; keep `lib/**` ≥86%. Pure target: `syncNamingCheck`.
- Migration human-gated (header ends "Human-gated (do not auto-apply)."); do NOT apply.
- Route handlers reading session/params set `export const dynamic="force-dynamic"`; Next 16 `await context.params`.
- Verify: `npm run verify`.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20260811_brand_labels.sql` | `brand_labels` + `brand_assets` extension. |
| `lib/brand/labels.ts` (+ `.test.ts`) | Types, CRUD, `syncNamingCheck`, `resolveApprovedLabels`. |
| `lib/query-keys.ts` | **Modify** → `brandLabels` keys. |
| `app/api/brand/labels/route.ts` | GET list + POST create. |
| `app/api/brand/labels/[id]/route.ts` | GET one + PATCH (update / approve / archive). |
| `app/brand/nav-config.ts` | **Modify** → Labels tab (adminOnly). |
| `app/brand/labels/page.tsx` (+ `useLabels.ts`) | Admin labels list + editor. |
| `app/brand/guide/page.tsx` | **Modify** → Tap-list section. |

## Execution Budget

- **Mode:** subagent-driven, economical. Migration (T1) done INLINE by controller. **G1** backend `lib`+API (T2,T3) · **G2** UI (T4,T5). Spawn cap = 4; final review INLINE (token guardrail). 2 spawns expected.

## Task / Model table

| Task | Deliverable | Model | How |
|---|---|---|---|
| 1 | `brand_labels` migration + assets extension | — | inline |
| 2 | `lib/brand/labels.ts` (+ tests) | Sonnet | G1 |
| 3 | labels API + query-keys | Sonnet | G1 |
| 4 | Labels nav + editor UI + hooks | Sonnet | G2 |
| 5 | guide Tap-list | Sonnet | G2 |
| 6 | verify + review | — | inline (controller) |

---

### Task 1 (inline): migration

Create `supabase/migrations/20260811_brand_labels.sql` per the spec's Schema section verbatim (table + RLS read-approved + `brand_assets` add `label_id`/`motif_family` + widen the `kind` check to include `label_art`). Human-gated. Commit `feat(brand): brand_labels table + assets label columns migration`.

---

### Task 2: `lib/brand/labels.ts`

**Interfaces:**
- `export interface Tier2Palette { colors: { name:string; hex:string; note?:string }[] }`
- `export interface NamingCheck { results: { criterion:string; pass:boolean; note?:string }[] }`
- `export interface BrandLabel { id:string; name:string; subtitle:string|null; description:string|null; motif_family:string|null; status:"draft"|"approved"|"archived"; tier2_palette:Tier2Palette; naming_check:NamingCheck; chop_glyph_asset_id:string|null }`
- `export function syncNamingCheck(criteria: string[], existing: NamingCheck): NamingCheck` — result set matches `criteria` order; existing `pass`/`note` preserved by criterion text; new criteria added as `{criterion, pass:false}`; stale dropped. (pure, tested)
- `listLabels(client, filter?:{status?})`, `getLabel(client,id)`, `createLabel(client,{name,subtitle?,description?,motif_family?})`, `updateLabel(client,id,patch)`, `approveLabel(client,id)`, `archiveLabel(client,id)`, `resolveApprovedLabels(client)`.

- [ ] **Step 1: failing test** for `syncNamingCheck`: preserves pass/note for a kept criterion; adds a new criterion as `pass:false`; drops a removed one; output order matches `criteria`.
- [ ] **Step 2: run** `npx vitest run lib/brand/labels.test.ts` — FAIL.
- [ ] **Step 3: implement** `labels.ts` (workflow fns take an injected client; a fake covers create→update→approve).
- [ ] **Step 4: run** + `npm run verify` — PASS.
- [ ] **Step 5: commit** `feat(brand): label CRUD + naming-check sync workflow`.

---

### Task 3: labels API + query-keys

Two routes, admin-gated (`requireRole([])`), `apiError`, `dynamic="force-dynamic"`, `createSupabaseAdminClient()` (mirror `app/api/brand/canon/*` and `app/api/brand/assets/*`):
- `route.ts`: `GET`→`listLabels` (`?status=`); `POST`→`createLabel`.
- `[id]/route.ts`: `GET`→`getLabel`; `PATCH`→ if body has `action` → approve/archive, else `updateLabel(id, body)`. `const {id} = await context.params`.
- `lib/query-keys.ts`: `brandLabels:{ all:()=>["brand","labels"], list:(s?)=>["brand","labels","list",s??"all"], one:(id)=>["brand","labels",id] }`.

- [ ] **Step 1:** implement routes + keys.
- [ ] **Step 2:** `npm run verify` — PASS.
- [ ] **Step 3: commit** `feat(brand): admin-gated labels API`.

---

### Task 4: Labels nav + editor UI

- `nav-config.ts`: add `{ href:"/brand/labels", label:"Labels", adminOnly:true }`.
- `useLabels.ts`: `useLabels(status?)`, `useLabel(id)`, `useCreateLabel()`, `useUpdateLabel()`, `useApproveLabel()`, `useArchiveLabel()` (invalidate keys). Mirror `app/brand/canon/useCanonEditor.ts`.
- `page.tsx` (client, admin, ops chrome): list + "New label"; editor facets — Details (name/subtitle/description/motif inputs), Naming check (fetch `canon.naming.criteria` via a published-canon read — call `GET /api/brand/canon/draft`? NO: read published criteria; simplest is to fetch the guide's canon through a small `GET`—reuse the existing published canon by importing `getCanon` is server-only, so expose criteria via a tiny server component prop OR fetch from a canon endpoint. Use: pass `criteria` from a server wrapper that calls `getCanon()` and renders the client editor with `criteria` prop), pass toggles + notes via `syncNamingCheck`; Tier-2 palette (add/remove name+hex+note); Chop glyph picker (GET `/api/brand/assets?kind=chop_glyph`, choose an approved one). Publish bar: Save / Approve / Archive. Reuse `<Card>`/`<Badge>`/`.btn-*`/`.inp`.

- [ ] **Step 1:** implement nav + hooks + page (+ a thin server wrapper supplying `criteria` from `getCanon()`).
- [ ] **Step 2:** `npm run build && npm run verify` — PASS.
- [ ] **Step 3: commit** `feat(brand): labels editor UI + Labels tab`.

---

### Task 5: guide Tap-list

Modify `app/brand/guide/page.tsx` (server): `resolveApprovedLabels(cookielessClient)` (reuse the guide's existing cookieless client), render a Tap-list section inside `.brand-surface` — each label: name (`font-brand-display`) — subtitle (`font-brand-body`) · motif. Omit the section if there are no approved labels.

- [ ] **Step 1:** implement.
- [ ] **Step 2:** `npm run build && npm run verify` — PASS.
- [ ] **Step 3: commit** `feat(brand): guide tap-list of approved labels`.

---

### Task 6 (inline): verify + review

Controller: `npm run build && npm run verify` green; inline review focusing on the label workflow (approve/archive correctness), `syncNamingCheck`, and the guide read; fix findings; push + PR.

## Definition of Done

- Verify green; `lib/**` ≥86%; build passes.
- Migration committed, NOT applied (human-gated).
- Label create→edit (naming check / Tier-2 / chop) → approve round-trips; guide Tap-list shows approved labels.
- Admin-only writes; no ops-chrome changes.

## Self-review

Coverage: table+assets ext → T1; workflow+syncNamingCheck → T2; API → T3; editor → T4; tap-list → T5. Types `BrandLabel`/`Tier2Palette`/`NamingCheck`/`syncNamingCheck` defined T2, consumed T3/T4/T5.

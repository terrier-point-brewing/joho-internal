# Orchestration Handoff — 2026-06-28

> **You are the orchestrator.** This document is your source of truth after a context clear.
> Read it fully, then create the worktrees and dispatch/guide the three feature sessions below.
> You do not write feature code yourself — you set up isolation, hand each session its plan,
> monitor, and integrate branches back into `main` with build verification.

---

## 1. Base state (as of handoff)

- **`main` @ `8dd9214`**, pushed to `origin` (`terrier-point-brewing/terrier-point-brewing`).
  `origin/main` auto-deploys to production (https://tpb-square-reports.vercel.app), so every
  push to `main` is a prod release.
- **Build:** `npm run build` passes. **Lint:** `npm run lint` (0 errors; some pre-existing warnings).
- **Working tree leftovers (ignore — not part of the base):** `.claude/settings.json` (local config),
  `backups/` (CSV data dumps).
- A **concurrent local session** may have a dev server on port `3000` in this working tree.
  Worktrees isolate you from it; don't kill its server without reason.

### Recovery / safety refs — DO NOT DELETE
| Ref | Points to | Why it matters |
|---|---|---|
| tag `stash-yesterday-uncommitted-20260627` | `a881fdc` | the recovered lost-work stash |
| branch `backup/morning-export-redesign-20260628` | `0adcd5a` | **source for `ShipmentsTab`/`ExportInvoicesTab` recovery in Feature #3** |
| branch `restore/yesterday-uncommitted-20260627` | restored base | history |
| branch `feature/export-rework` | merged into `main` | already integrated; do not reuse — branch fresh |

---

## 2. CRITICAL — live schema reality (read before ANY DB work)

~15 migrations were applied to the live DB on 2026-06-28; the restored code was reconciled to
them across this session. **New code MUST target the migrated schema**, or it will reintroduce the
drift bugs we just fixed.

Applied & reconciled (use the NEW form):
- `recipes.brewery` → **`recipes.partner_id`** (FK → `contract_brewing_partners`). For display, embed
  `partner:contract_brewing_partners(company_name)`. `recipes.brew_time_weeks` and `recipes.steps` **dropped**.
- `commitments.beer_style` **dropped** → commitments key on **`recipe_id`**; derive the name via
  embed `recipes(beer_name)`.
- Dropped (no longer reference): `batch_allocations.{label,locked,lock_reason,locked_at}`,
  `batch_transfers.{export_detail,kegging_detail,canning_detail,packaging_item_id,variant_label}`,
  `brew_batches.packaging_status`, `export_transactions.channel_type`,
  `commitments.{packaging_item_id,packaging_qty}`.

**NOT yet applied** (Feature #3 owns it):
- `supabase/migrations/20260708_export_invoice_fk.sql` — `export_transactions.square_invoice_id`
  **still exists**; `invoice_id` FK is **not** present; `invoice_line_items.square_catalog_variation_id`
  **not** present. Apply this only inside Feature #3.

**Verification tooling:**
- Supabase project id: `drlsazatrcrdwaihjmex`. Use the Supabase MCP `execute_sql` to confirm schema.
- Validate PostgREST embeds against the live DB with an **anon-key REST call**
  (`curl "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/<table>?select=...&limit=2" -H "apikey: $KEY" -H "Authorization: Bearer $KEY"`).
  A malformed embed returns HTTP 400 regardless of RLS; a valid one returns 200. **Page-level curl
  redirects to /login (auth)** — you cannot see authed pages without a session, so verify data paths
  this way + via build.

---

## 3. Conventions every feature session must follow

- Read `CLAUDE.md` + `AGENTS.md` first. **This is Next.js 16 — not the Next.js in training data.**
- One **git worktree per feature** (isolation). Build + lint + verify **before** committing.
- No business logic in `app/api/**` or page components → `lib/`. Auth via `lib/auth.ts`. Parse params
  with `requireDateRange()`/`apiError()`. Pick the Supabase client matching context (server/browser/admin).
- Schema changes = **new** migration file; never hand-edit an existing one. Read latest `supabase/migrations/`.
- End every commit message with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Use the `superpowers:executing-plans` (review checkpoints) or `superpowers:subagent-driven-development`
  skill to execute the task-numbered plans.

---

## 4. The three features

### Sequencing decision (locked)
- **#1 Payroll — run in PARALLEL** (independent new module, no shared surface).
- **#2 SKU consolidation → then #3 Export Phase 2 — SEQUENCED.** They both touch
  `exportInvoicePreview.ts`, `recipe_square_links`, and `RecipeLinkMatrix`. #2 merges to `main`
  first; **#3 branches off the updated `main`** so it builds on #2's re-grained matrix/resolver.

### Feature #1 — Employee shift & payroll management  `[PARALLEL]`
- Worktree/branch: `feature/payroll-shifts` off `main`.
- Plan: `docs/superpowers/plans/2026-06-28-payroll-shift-management.md`
  Design: `docs/superpowers/specs/2026-06-28-payroll-shift-management-design.md`
- New module; low collision risk. Can start immediately and merge whenever green.

### Feature #2 — Square line-item mapping consolidation (recipe × packaging-variation grain)  `[SEQUENCE 1]`
- Worktree/branch: `feature/sku-mapping-consolidation` off `main`.
- Plan: `docs/superpowers/plans/2026-06-28-square-sku-mapping-consolidation.md` (11 tasks; **Task 1
  stands up a Vitest harness** — there is currently no test runner, so this introduces one).
- Scope: unit parser (`lib/square/catalogUnits.ts`), catalog-mirror unit columns, **re-grain
  `recipe_square_links` to `variation_id`** (migration), unified resolver `lib/square/skuMappings.ts`,
  export-invoice product lines, sell-through, and the **`RecipeLinkMatrix` re-grain + UI rework**.
- Builds on what's already on `main`: the Phase 1 `RecipeLinkMatrix`, the expanded
  `useRecipePackagingVariationsExpandedQuery`, and `RecipePackagingVariationExpanded`/`RecipeSquareLinkRow` types.
- **Must merge to `main` before #3 starts.**

### Feature #3 — Phase 2 export UI redesign + deferred UX polish  `[SEQUENCE 2 — after #2 merges]`
- Worktree/branch: `feature/export-phase2` off **updated `main`** (post-#2 merge).
- Plans: `docs/superpowers/plans/2026-06-27-export-ui-redesign.md` +
  `docs/superpowers/plans/2026-06-27-export-settings-ui-rework.md`.
- Scope:
  - Apply `20260708_export_invoice_fk.sql` (**UNAPPLIED, destructive — back up `export_transactions`
    first**; backfills `invoice_id` from `square_invoice_id → invoices.square_invoice_id`, then drops the column).
  - Recover `ShipmentsTab.tsx` + `ExportInvoicesTab.tsx` from `backup/morning-export-redesign-20260628`.
  - Build the 4-section `ExportTab` (Export Bay / Shipments / Export Invoices); retire `ExportTransactionsTab`.
  - Update `exports/route.ts` + `export/invoice/route.ts` to the `invoice_id` FK.
- **Already on `main` — do NOT redo:** the export-settings UX refactor (shared `ServiceMappingSection`
  + save-feedback `SaveIndicator`/`useSaveStatus`) and the inline `RecipeLinkMatrix` in `ExportSettingsPanel`.
- **Deferred UX polish to fold in** (from the export-settings review):
  - Denser / partner-centric layout for the mapping sections (currently a long single-column scroll).
  - Accessibility pass on the Excise + Invoice-Terms inputs (real `<label>`s, example placeholders).
  - **`bulk_discount` inconsistency**: `lib/production/exportInvoicePreview.ts:236` reads only the
    *default* `bulk_discount` mapping (ignores partner overrides) while the UI offers overrides — reconcile.

---

## 5. Integration plan
1. Each feature: build + lint + anon-REST verify, then merge to `main` (or open a PR).
2. #1 may merge any time it's green. **#2 merges first**; then rebase/branch **#3** on the updated `main`;
   #3 merges after.
3. Re-run `npm run build` on `main` after each merge. Push to `origin` per your release cadence
   (remember: prod deploy).
4. Keep the safety refs in §1 until all three features are merged and verified.

---

## 6. Ready-to-paste session prompts

Use one per fresh session/sub-agent. Each assumes its worktree already exists (you create it).

**#1 — Payroll**
> You are implementing the Employee Shift & Payroll module for the TPB Square Reports app.
> Read `CLAUDE.md` and `AGENTS.md` (Next.js 16). Execute the plan at
> `docs/superpowers/plans/2026-06-28-payroll-shift-management.md` (design at
> `docs/superpowers/specs/2026-06-28-payroll-shift-management-design.md`) using the
> `superpowers:executing-plans` skill. This is a new, independent module. Honor the live-schema
> notes and conventions in `docs/superpowers/2026-06-28-orchestration-handoff.md` §2–3. Build + lint
> before each commit; co-author commits as Opus 4.8. Do not merge to main — report when green.

**#2 — SKU mapping consolidation**
> You are implementing the Square SKU Mapping Consolidation (recipe × packaging-variation grain).
> Read `CLAUDE.md`/`AGENTS.md` and `docs/superpowers/2026-06-28-orchestration-handoff.md` §2–3
> (live schema + conventions) FIRST. Execute `docs/superpowers/plans/2026-06-28-square-sku-mapping-consolidation.md`
> (11 tasks; Task 1 introduces a Vitest harness) via `superpowers:executing-plans`. You re-grain
> `recipe_square_links` to `variation_id`, build `lib/square/skuMappings.ts`, and rework the
> `RecipeLinkMatrix` — verify every PostgREST embed against the live DB (anon-key REST). Build + lint
> before each commit. Report when green; this branch must merge before the export Phase 2 work begins.

**#3 — Export Phase 2 + UX polish** (start only after #2 is merged)
> You are implementing Phase 2 of the Export UI Redesign + deferred UX polish, on a branch off the
> post-#2 `main`. Read `CLAUDE.md`/`AGENTS.md` and `docs/superpowers/2026-06-28-orchestration-handoff.md`
> §2–4 FIRST. Execute `docs/superpowers/plans/2026-06-27-export-ui-redesign.md` +
> `2026-06-27-export-settings-ui-rework.md`. Apply the UNAPPLIED `20260708_export_invoice_fk.sql`
> (back up `export_transactions` first). Recover `ShipmentsTab.tsx`/`ExportInvoicesTab.tsx` from branch
> `backup/morning-export-redesign-20260628`. Do NOT redo the `ServiceMappingSection`/save-feedback
> refactor or the inline matrix — they're already on main. Fold in the deferred UX polish in §4.
> Build + lint + verify before each commit. Report when green.

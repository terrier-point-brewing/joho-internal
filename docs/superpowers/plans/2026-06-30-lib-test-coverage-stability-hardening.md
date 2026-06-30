# lib/ Test Coverage & Stability Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute this plan. Dispatch one fresh subagent per workstream, each in its own git worktree. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the untested `lib/` business-logic layer into an enforced regression safety net, and produce read-only audits of schema issues and dead code — entirely as PRs left open for review.

**Architecture:** Three parallel, non-overlapping workstreams. (A) An **enforcement scaffold** that makes the test suite gate every PR (one PR, touches `ci.yml` + `vitest.config.ts` + `CLAUDE.md`). (B) Seven **test-backfill** workstreams, each owning a disjoint set of `lib/` modules and producing only `lib/**/*.test.ts` files. (C) One **audit** workstream producing a findings report plus *draft* migration files and a dead-code-removal PR — applying nothing to the live database. Because every workstream writes to a disjoint file set, all resulting PRs are independently mergeable with zero conflicts.

**Tech Stack:** Vitest 4 + `@vitest/coverage-v8` (already installed), TypeScript strict mode, Next.js 16, Supabase Postgres. Test environment is `node`; include glob is `lib/**/*.test.ts`.

## Global Constraints

- **Landing policy: PRs, leave all for review.** No workstream merges to `main`. Each opens a PR and stops. The human merges on return.
- **No source changes in test workstreams.** Test agents add `*.test.ts` files only. If a test reveals a genuine bug in source, the agent writes the test to document *actual current behavior*, adds a `// BUG:` comment + a failing `it.fails(...)` or `it.skip` with a note, and records it in the workstream's PR description — it does **not** edit the source to "fix" it.
- **No migrations applied to the live DB.** The audit workstream is read-only against the database. It may *write* draft `.sql` migration files into `supabase/migrations/` on its branch, but must never run `apply_migration` or any DDL/DML against the project (Supabase project ID `drlsazatrcrdwaihjmex`). This matches the standing prod-DB authorization rule: only the human applies migrations, per-migration, after explicit OK + backup.
- **Follow existing test style verbatim.** The six existing test files are the canonical templates — match their import style (`import { describe, it, expect } from "vitest"`), naming, and assertion patterns. Path alias `@` → repo root is configured.
- **Token utilities / UI rules do not apply** — this is non-UI logic work.
- **One responsibility per test file.** `lib/foo/bar.ts` → `lib/foo/bar.test.ts` (co-located), matching the existing convention (except `lib/payroll/__tests__/` which already uses a `__tests__` subdir — match whichever pattern the sibling files use).

---

## Existing State (verified 2026-06-30)

- **CI already exists** at `.github/workflows/ci.yml`: runs `npm run lint`, `npx tsc --noEmit`, `npm run build` on push/PR to `main`. **It does NOT run `npm run test`.** ← the core enforcement gap.
- **Test runner configured**: `package.json` `"test": "vitest run"`; `vitest.config.ts` present; `@vitest/coverage-v8@^4` installed but **no coverage config and no thresholds**.
- **6 existing test files** (templates): `lib/square/skuMappings.test.ts`, `lib/square/catalogUnits.test.ts`, `lib/production/squareMappingGrid.test.ts`, `lib/finance/classify.test.ts`, `lib/payroll/__tests__/calculations.test.ts`, `lib/payroll/__tests__/periodUtils.test.ts`.
- **~52 untested `lib/` modules.** Type health is good (strict on, ~6 `any`).

---

## Workstream A: Enforcement Scaffold (do FIRST)

**Why first:** This is the highest-leverage change. It makes tests actually gate PRs and establishes the coverage ratchet the other workstreams feed. Its PR should be reviewed/merged before bumping thresholds, but it does NOT block the test workstreams from running in parallel (they touch disjoint files).

**Files:**
- Modify: `.github/workflows/ci.yml` — add a Test step
- Modify: `vitest.config.ts` — add coverage provider + reporters + baseline thresholds
- Modify: `CLAUDE.md` — add the "tests required for lib/ modules" rule

**Branch:** `claude/stability-enforcement`

- [ ] **Step 1: Measure the current coverage baseline**

Run: `npm run test -- --coverage` (it will warn that coverage provider needs config; if it errors, temporarily add the config from Step 3 first, then measure). Record the overall `% Lines` / `% Statements` / `% Functions` / `% Branches` printed in the summary table. Call the lines number `BASELINE_LINES` (round **down** to the nearest whole percent).

- [ ] **Step 2: Add the Test step to CI**

In `.github/workflows/ci.yml`, after the `Type-check` step and before `Build`, insert:

```yaml
      - name: Test
        run: npm run test
```

(Tests are pure-logic and need no secrets, so no `env:` block.)

- [ ] **Step 3: Add coverage config + baseline thresholds to `vitest.config.ts`**

Replace the `test` block so it reads:

```ts
import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": resolve(__dirname, ".") },
  },
  test: {
    include: ["lib/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "html"],
      include: ["lib/**/*.ts"],
      exclude: ["lib/**/*.test.ts", "lib/**/types.ts"],
      // Ratchet: never let coverage regress below the current floor.
      // Raise these toward 70 once the backfill PRs land (see Definition of Done).
      thresholds: {
        lines: BASELINE_LINES,        // ← replace with the measured integer
        statements: BASELINE_LINES,   // ← replace with the measured integer
        functions: 0,                 // raised after backfill
        branches: 0,                  // raised after backfill
      },
    },
  },
});
```

Note: CI runs `npm run test` (no `--coverage`), so thresholds do not fail CI yet — they document the floor and are enforced by `npm run test -- --coverage` locally and in the threshold-raise step at the end. (If you want CI to enforce coverage immediately, change the CI Test step to `npm run test -- --coverage`; default to NOT doing this until the backfill lands, to avoid a red main.)

- [ ] **Step 4: Add the standing rule to `CLAUDE.md`**

Under the `## Rules` section, add this bullet:

```
- New or modified `lib/` business-logic modules ship with co-located `*.test.ts` covering the pure logic paths; CI runs `npm run test` on every PR. Don't drop `lib/` coverage below the `vitest.config.ts` threshold floor.
```

- [ ] **Step 5: Verify locally**

Run: `npm run test` → Expected: PASS (existing 6 files green).
Run: `npm run lint` → Expected: clean.

- [ ] **Step 6: Commit + open PR (do not merge)**

```bash
git add .github/workflows/ci.yml vitest.config.ts CLAUDE.md
git commit -m "ci(test): gate PRs on vitest + add lib/ coverage ratchet"
```
Open a PR titled `ci: enforce lib/ test suite on every PR + coverage ratchet`. PR body: explain the gap (CI didn't run tests), the baseline number, and the plan to raise thresholds after backfill. **Leave open.**

---

## Workstreams B1–B7: lib/ Test Backfill (parallel)

Each is an independent subagent in its own worktree on its own branch, producing ONLY new `lib/**/*.test.ts` files for its assigned modules, then opening a PR and stopping.

### Shared methodology (every test workstream follows this)

These are **characterization + unit tests**: lock in the module's *actual current behavior* so future changes can't silently regress it.

1. **Read the module fully** before writing anything. Identify every exported function and its pure inputs/outputs.
2. **Test pure logic, not I/O.** For functions that call Square/Supabase/network, test only the pure transform/mapper/validator helpers. If a module is *entirely* I/O orchestration with no extractable pure logic, note "no pure logic to test" in the PR body and skip it — do not mock an entire database to assert a mock was called.
3. **Per exported pure function, cover:** the happy path, each documented branch/category, boundary values (zero, empty array/string, negative, rounding edges — money in cents, volume in fl oz/BBL), and the explicit "unknown/fallback" path.
4. **Match the template style** of the six existing test files exactly.
5. **Run `npm run test` and confirm green** before committing.
6. **If a test surfaces a real bug:** document current behavior in a passing test, add a `// BUG:` comment, list it in the PR body under "Bugs found (not fixed)". Never edit source.
7. **Quality bar (reject your own test if):** it asserts a mock was called instead of a real output; it's a giant snapshot with no semantic assertion; it duplicates a branch already covered; it tests TypeScript types rather than runtime behavior.

### Reusable dispatch prompt (orchestrator uses this per workstream)

> You are writing characterization + unit tests for a subset of the `lib/` layer in the TPB Square Reports repo (Next.js 16, Vitest 4, TS strict). Read `docs/superpowers/plans/2026-06-30-lib-test-coverage-stability-hardening.md` sections "Shared methodology" and "Global Constraints" and follow them exactly. Study the six existing `*.test.ts` files as style templates. Your assigned modules are: **[LIST]**. For each, read it fully, write a co-located `*.test.ts` covering pure-logic paths per the methodology, run `npm run test` until green, and commit. Add NO source changes. When done, open a PR titled `test([domain]): characterize [domain] lib modules` listing per-module coverage and any bugs found; leave it open. Branch: `[BRANCH]`.

### Module assignments (disjoint — no two workstreams share a file)

- [ ] **B1 — finance** · branch `claude/test-finance`
  Modules: `lib/finance/invoiceSalesReport.ts`, `lib/finance/qb-csv.ts`, `lib/finance/qb-pdf.ts` (pure parse helpers only), `lib/finance/syncSquareInvoices.ts` (pure mappers only). *(`classify.ts` already tested — extend only if gaps.)*

- [ ] **B2 — payroll** · branch `claude/test-payroll`
  Modules: `lib/payroll/previewService.ts` (pure calc paths only), `lib/payroll/types.ts` (skip — types only). *(`calculations.ts`, `periodUtils.ts` already tested — extend only if uncovered branches remain.)*

- [ ] **B3 — production-core** · branch `claude/test-production-core`
  Modules: `lib/production/exciseTax.ts`, `lib/production/coldStorageDepletion.ts`, `lib/production/commitmentFulfillment.ts`, `lib/production/commitments.ts`, `lib/production/batchCompletion.ts`. **Read `docs/production-schema.md` and `app/production/lib/volumeLedger.ts` first** — these encode GALLONS_PER_BBL / BBL_TO_FL_OZ conventions (`lib/constants/production.ts`). Test volume/excise math at boundaries.

- [ ] **B4 — production-export** · branch `claude/test-production-export`
  Modules: `lib/production/exportInvoicePreview.ts`, `lib/production/packagingVariations.ts`, `lib/production/exportBayEquipment.ts`, `lib/production/exportTransactionWriter.ts` (pure builders only). Channel logic (contract_brewing / distribution / wholesale) and excise-charged-vs-volume distinctions matter — see `docs/production-schema.md`.

- [ ] **B5 — square** · branch `claude/test-square`
  Modules: `lib/square/sell-through.ts`, plus pure mappers/transformers extracted from `lib/square/client.ts`, `catalog.ts`, `orders.ts`, `customers.ts`, `inventory.ts`, `refunds.ts`, `labor.ts`, `square-invoices.ts`. Skip raw `fetch` wrappers with no pure logic. *(`catalogUnits.ts`, `skuMappings.ts` already tested.)*

- [ ] **B6 — reports** · branch `claude/test-reports`
  Modules: `lib/reports/bbl-tracker.ts`, `cocktails.ts`, `combos.ts`, `contract-brewing.ts`, `distribution.ts`, `kegs.ts`, `taproom-model.ts`. These are report builders — ideal pure-logic targets. Cover aggregation, grouping, and empty-input paths.

- [ ] **B7 — utils/format** · branch `claude/test-utils`
  Modules: `lib/utils/datetime.ts`, `lib/utils/formatting.ts`, `lib/utils/orders.ts`, `lib/utils/api.ts` (`requireDateRange`, `apiError` — test param parsing + error shapes), `lib/utils/memo.ts`, `lib/format.ts`, `lib/constants/categories.ts`. High-traffic shared helpers; cover edge cases thoroughly since everything depends on them.

**Out of scope (do not test):** `lib/supabase/*` (client factories), `lib/env.ts`, `lib/ramp.ts`, `lib/resend.ts`, `lib/query-keys.ts`, `lib/hooks/*` (React hooks — wrong env), `lib/auth.ts` (integration-bound; note for a future workstream).

---

## Workstream C: Schema & Dead-Code Audit (read-only)

**Branch:** `claude/audit-schema-deadcode`

**Deliverables (all on the branch, as a PR left open):**
- `docs/audits/2026-06-30-schema-audit.md` — findings report
- `docs/audits/2026-06-30-dead-code-audit.md` — findings report
- `supabase/migrations/` — **draft** migration files for each safe, approved-shape schema fix (clearly headed `-- DRAFT — DO NOT APPLY WITHOUT REVIEW`), never executed
- A dead-code report only (per landing policy "report + draft, don't apply", the human decides removals)

- [ ] **Step 1: Schema audit.** Use the `anthropic-skills:supabase-db-audit` skill (it is strictly read-only by design). Audit project `drlsazatrcrdwaihjmex` for: unused/orphaned tables, duplicate/near-duplicate tables or columns, naming inconsistencies, missing/orphaned foreign keys, type mismatches, RLS gaps, and leftover third-party sync columns (Square/Ramp). Cross-check against `supabase/migrations/` (source of truth) and `docs/production-schema.md`. Write findings to the report path above, ranked by severity with the evidence for each.

- [ ] **Step 2: Draft migrations (do not apply).** For each finding that is a clearly-safe, well-understood fix (e.g. dropping a provably-unused column, adding a missing FK/index), write a new timestamped draft migration file. Header each with `-- DRAFT — DO NOT APPLY WITHOUT REVIEW` and a comment explaining the finding. **Run no DDL/DML.** Do NOT call `apply_migration`.

- [ ] **Step 3: Dead-code audit.** Find unreferenced exports, unused files, and unreachable code across `app/` and `lib/`. Useful signals: `npx tsc --noEmit` is already clean, so lean on grep for import references and on the 30 existing tech-debt markers (`TODO/FIXME/HACK/@ts-ignore/eslint-disable`). For each candidate, record the file, why it appears unused, and a confidence level. Report only — make no deletions (per landing policy).

- [ ] **Step 4: Commit + open PR (do not merge).** Title: `audit: schema + dead-code findings (report + draft migrations, none applied)`. PR body summarizes top findings and explicitly states no migrations were applied and no code deleted. **Leave open.**

---

## Orchestration (how the cloud session runs this)

1. **Sync `.env.local`** per CLAUDE.md worktree setup before any `npm` command (symlink to main worktree's `.env.local`).
2. **Dispatch all workstreams as parallel background subagents, each with `isolation: "worktree"`** so they don't collide. Workstream A and B1–B7 and C all write disjoint file sets, so they can run fully concurrently.
3. **Do not merge anything.** Collect PR URLs as agents finish.
4. **Cadence:** schedule periodic check-ins (e.g. 20–30 min) to collect completions; re-dispatch any workstream that failed with a tightened prompt. Each subagent is bounded by its module list, so runtime is finite.
5. **On completion, post a summary** to the human: list of open PRs (one per workstream), bugs found (from B-series PR bodies), top schema/dead-code findings, and the recommended threshold-raise (below).

## Definition of Done

- [ ] Workstream A PR open: CI runs `npm run test`; `vitest.config.ts` has baseline thresholds; `CLAUDE.md` rule added.
- [ ] B1–B7 PRs open: each assigned pure-logic module has a co-located test file (or a documented "no pure logic" skip); `npm run test` green on each branch.
- [ ] Workstream C PR open: two audit reports + any draft migrations (none applied) + dead-code report.
- [ ] Summary delivered to the human with all PR links and the measured new overall coverage %.
- [ ] **Final threshold-raise (left for the human / a follow-up once B-PRs merge):** after the backfill PRs land, re-measure coverage and raise `lines`/`statements`/`functions`/`branches` in `vitest.config.ts` toward the new floor (target ~70% lines), and optionally switch the CI Test step to `npm run test -- --coverage` to hard-gate coverage. This is a one-line follow-up PR, intentionally deferred because it depends on the backfill being merged first.

---

## Self-Review

**Spec coverage:** Test backfill (B1–B7 cover all Tier-1 pure modules + pure parts of Tier-2; out-of-scope list is explicit) ✓. Enforcement / "reliably used" (Workstream A: CI test step + ratchet + CLAUDE.md rule) ✓. Schema issues (Workstream C Steps 1–2, read-only + draft) ✓. Dead code (Workstream C Step 3, report-only) ✓. Landing = PRs left for review (Global Constraints + every workstream ends "leave open") ✓. No live-DB changes (Global Constraints + C explicit) ✓.

**Placeholder scan:** `BASELINE_LINES` and `[LIST]`/`[BRANCH]`/`[domain]` are intentional fill-ins with explicit instructions for how to resolve them, not vague TODOs. Module lists are exact paths. No "add error handling"-style placeholders.

**Type/consistency:** Branch names are unique per workstream and referenced consistently. File sets are disjoint (verified against the `lib/` tree): A touches `ci.yml`/`vitest.config.ts`/`CLAUDE.md`; B-series touch only `lib/**/*.test.ts` in their domain; C touches `docs/audits/*` + `supabase/migrations/*` — no overlap, so PRs are conflict-free.

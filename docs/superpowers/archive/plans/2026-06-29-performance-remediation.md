# Performance Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the seven performance issues from the 2026-06-29 audit — collapse duplicate auth/data fetches onto TanStack Query, code-split recharts + React Flow, remove a dead dependency, add route loading skeletons, and fix one O(rows²) projection — with zero behavior change.

**Architecture:** Three raw `useEffect`+`fetch` paths move onto the existing TanStack Query layer via new **shared, reusable hooks** (an `auth` domain hook colocated with `useUserRole`; a new `app/finance/hooks/queries.ts` module mirroring `app/production/hooks/queries.ts`). Heavy client libraries (`recharts`, `@xyflow/react`) become `next/dynamic({ ssr: false })` chunks loaded only when their tab opens. `loading.tsx` segment files give the App Router instant skeletons. No new runtime libraries; `@uiw/react-md-editor` is removed.

**Tech Stack:** Next.js 16.2.6 (App Router), React 19 + **React Compiler ON** (`next.config.ts: reactCompiler: true`), TanStack Query v5, TypeScript, Tailwind v4, Supabase, vitest (pure-logic only).

## Global Constraints

Copied verbatim from the spec and CLAUDE.md — every task implicitly includes these:

- **React Compiler is ON globally.** Do NOT add manual `useMemo` / `React.memo` / `useCallback` for memoization. The compiler auto-memoizes. (Existing `useCallback`s with eslint-disable comments stay as-is; don't add new ones.)
- **No new libraries.** Only `@tanstack/react-query` (installed) and `next/dynamic` (built-in). `@uiw/react-md-editor` is **removed**.
- **Query-key registry is `lib/query-keys.ts`; "every key is a function"** — even no-argument keys are functions returning `as const` tuples.
- **Shared `fetchJson` lives in `app/production/hooks/queries.ts`** (exported). Reuse it; do not redefine fetch helpers.
- **`QueryClient` is in `app/providers.tsx`** — `staleTime: 30_000`, `refetchOnWindowFocus: false`, `retry: 1`. Do not change these defaults.
- **`useUserRole`'s public return shape `{ user, role, loading }` must stay byte-for-byte identical** — 10 consumers depend on it.
- **`next/dynamic` with `ssr: false` only works inside Client Components** (`"use client"`). All target files already are.
- **Business logic in `lib/` / feature `hooks/` modules, not in `app/api/**` or page bodies.** Reuse existing routes/tables; no new tables or routes are introduced by this plan.
- **`ssr: false` named-export dynamic import** uses the `.then((m) => m.Name)` form.
- **AGENTS.md:** This is NOT stock Next.js. Before editing `loading.tsx` or `next/dynamic` code, read `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/loading.md` and `node_modules/next/dist/docs/01-app/02-guides/lazy-loading.md`.
- **Shared formatting lives in `@/lib/format`** (added by PR #43, merged into `origin/main` after this plan's first draft): `formatCurrencyCents(cents, decimals=2)`, `formatCurrency(dollars, decimals=2)`, `formatNumber`, `formatPercent(value, decimals=1)`. Reuse these — **never reintroduce a local currency/percent formatter.** All target files already import from it.

> **⚠️ Base-drift caveat — READ BEFORE EDITING ANY EXISTING FILE.** This plan was first drafted against an older `main` (`fb98d9a`); PR worktrees branch off the current `origin/main`, where the #43 formatting refactor and an invoices "Type column / showVoided" change have **shifted line numbers** and added `@/lib/format` imports. Therefore: **locate every edit by its quoted code anchor, not by the absolute line numbers in this plan** (line numbers are indicative only). Before editing, `Read` the live file in your worktree and confirm the anchor text exists. The data-layer anchors this plan targets (the auth/CoA/batches `useEffect`s, the `allInvoices` projection, the `useState`s) are all still present on `origin/main` — only their positions moved. If an anchor genuinely no longer exists, report `BLOCKED` rather than guessing.

### Verification model (read before starting)

There is a vitest runner, but it only covers **pure logic in `lib/`** (e.g. `lib/square/skuMappings.test.ts`). There is **no `@testing-library/react`** installed, and none of these 7 fixes introduce new pure-logic functions. Adding a component-testing framework is out of scope (YAGNI). Therefore each task is verified by:

1. `npm run build` — must complete clean (no type errors, no new warnings).
2. `npm run lint` — must pass clean.
3. The fix-specific **manual check** from the spec's Verification table (reproduced per task), run against `npm run dev` with the browser DevTools Network panel.

**Do NOT write unit tests for these tasks** — there is no harness that can exercise React hooks/components here, and fabricated tests that can't run are a plan failure.

### Git policy (user instruction — overrides skill defaults)

This work ships as **several small, area-isolated PRs** (see "PR Breakdown" below) to avoid merge conflicts with the other agents working in parallel on payroll, SKU mapping, export/invoicing, and UI standardization.

**Do NOT create branches, `git add`, `git commit`, or `git push` until the user explicitly authorizes it.** When authorized, each PR gets its own branch off `main` (its own worktree) so they merge independently. Each task ends at a **verify checkpoint**, not a commit; commits/PRs happen per-PR-group only on the user's go-ahead. The writing-plans/subagent-driven-development skills' per-task commit step is **suppressed** by explicit user instruction.

---

## PR Breakdown

Seven PRs, grouped by app area so each PR collides with at most one other agent's area. **`lib/query-keys.ts` (the one hot, shared file) is touched only by PR 1** — every other PR only *reads* keys.

| PR | Branch | Tasks | Fixes | Files | Depends on | Conflict surface |
|----|--------|-------|-------|-------|-----------|------------------|
| **1. Query foundation** | `perf/query-foundation` | 1, 2, 3 | #1 | `lib/query-keys.ts` (edit), `lib/hooks/useUserRole.ts` (edit), `app/finance/hooks/queries.ts` (**new**) | — | `query-keys.ts` only — **additive** (new `auth` block + 2 finance keys); trivial conflict resolution vs. payroll/sku/export key additions |
| **2. Finance statements** | `perf/finance-statements` | 4 | #4 | `app/finance/statements/{pl,cash-flow,balance-sheet}/page.tsx` | **PR 1** | statements pages only (low-traffic) |
| **3. Finance invoices** | `perf/finance-invoices` | 5, 6 | #6, #7 | `app/finance/invoices/page.tsx` | **PR 1** | invoices page — **HOT** (export-phase2 / three-channel-invoicing). Isolated to one file, merge fast |
| **4. Taproom chart code-split** | `perf/taproom-charts` | 8, 9, 10 | #3 | `app/components/ChartSkeleton.tsx` (**new**), `app/taproom/components/{SalesPulse,DraftStats,Achievement}Tab.tsx` (edit), `…Chart.tsx` ×3 (**new**) | — | taproom components only (vs. ui-standardization) |
| **5. Production schedule code-split** | `perf/production-schedule-lazy` | 11 | #3 | `app/production/components/BatchLogTab.tsx` | — | BatchLogTab — **HOT** (production/backfill agents). ~6-line change, merge fast |
| **6. Route skeletons** | `perf/route-skeletons` | 12 | #5 | `app/finance/statements/loading.tsx`, `app/finance/invoices/loading.tsx`, `app/production/loading.tsx` (all **new**) | — | **none** — all new files, zero conflict |
| **7. Remove dead dep** | `perf/remove-md-editor` | 7 | #2 | `package.json`, `package-lock.json` | — | lockfile only (vs. any dep change). Tiny, merge anytime |

**Setup (Task 0 — `npm install`)** is per-worktree environment prep, not a committed change; run it once in whatever worktree a PR is built in.

### Merge order

- **PR 1 must merge first** — PRs 2 and 3 import its new hooks/keys.
- **PRs 4, 5, 6, 7 are fully independent** of PR 1 and of each other — open and merge them in any order, including before PR 1.
- **PRs 2 and 3** open after PR 1 lands (or rebase onto it). They touch disjoint finance files, so 2 and 3 don't conflict with each other.

### Why this split

- One PR per app area → each only overlaps the single agent working that area.
- The two known **hot single files** (invoices page, BatchLogTab) each get their own tiny PR that can merge the moment it's green, minimizing the window for conflict.
- The cross-cutting key registry is quarantined in PR 1, so the additive `query-keys.ts` edit happens exactly once.
- 5 of 7 PRs have **zero or near-zero** conflict surface and need no sequencing.

---

## File Structure

**Created:**
- `app/finance/hooks/queries.ts` — finance data-layer hooks (`useChartOfAccountsQuery`, `useStatementsQuery`, `useBalanceSheetQuery`) + exported `CoARef` type. Mirrors `app/production/hooks/queries.ts`.
- `app/components/ChartSkeleton.tsx` — shared loading placeholder for lazy chart chunks.
- `app/taproom/components/SalesPulseChart.tsx` — extracted recharts subtree for SalesPulseTab.
- `app/taproom/components/DraftStatsChart.tsx` — extracted recharts subtree for DraftStatsTab.
- `app/taproom/components/AchievementChart.tsx` — extracted recharts subtree for AchievementTab.
- `app/finance/statements/loading.tsx` — route skeleton.
- `app/finance/invoices/loading.tsx` — route skeleton.
- `app/production/loading.tsx` — route skeleton.

**Modified:**
- `lib/query-keys.ts` — add `auth` domain + `finance.chartOfAccounts` + `finance.statements`.
- `lib/hooks/useUserRole.ts` — add `useAuthMeQuery`; rewrite `useUserRole` to delegate (same shape).
- `app/finance/statements/pl/page.tsx` — use `useStatementsQuery(year, "mom")`.
- `app/finance/statements/cash-flow/page.tsx` — use `useStatementsQuery(year, "cash")`.
- `app/finance/statements/balance-sheet/page.tsx` — use `useBalanceSheetQuery(year, month)`.
- `app/finance/invoices/page.tsx` — CoA + batches onto query hooks (#6); hoist `allInvoices` (#7).
- `app/taproom/components/SalesPulseTab.tsx` — dynamic-import the chart.
- `app/taproom/components/DraftStatsTab.tsx` — dynamic-import the chart.
- `app/taproom/components/AchievementTab.tsx` — dynamic-import the chart.
- `app/production/components/BatchLogTab.tsx` — dynamic-import `EquipmentScheduleSection`.
- `package.json` / `package-lock.json` — remove `@uiw/react-md-editor`.

## Dependency / ordering graph

```
Task 0 (npm install + baseline)  ── must run first
   │
   ├── GROUP A (foundation FIRST, then consumers):
   │     Task 1 (query keys) ──► Task 2 (#1 useUserRole)
   │                         └─► Task 3 (finance hooks) ──► Task 4 (#4 statements)
   │                                                    └─► Task 5 (#6 invoices data) ──► Task 6 (#7 hoist, same file)
   │
   ├── GROUP B (independent of A; Task 8 creates the shared skeleton):
   │     Task 7 (#2 remove dep)            [fully independent]
   │     Task 8 (#3 SalesPulse + ChartSkeleton) ──► Task 9 (#3 DraftStats)
   │                                              └─► Task 10 (#3 Achievement)
   │     Task 11 (#3 EquipmentSchedule)    [independent of 8/9/10]
   │
   ├── GROUP C: Task 12 (#5 loading.tsx)  [fully independent]
   │
   └── GROUP D: folded into Tasks 5/6 (same file as #6)
```

**Hard rules:** Task 1 before 2 and 3. Task 3 before 4 and 5. Task 5 before 6 (both edit `app/finance/invoices/page.tsx` — never run concurrently). Task 8 before 9 and 10 (they import `ChartSkeleton`). Everything else is order-independent.

---

## Task 0: Worktree setup & baseline

**Files:** none (environment only).

**Interfaces:**
- Produces: a working `node_modules` so every later task can run `npm run build` / `npm run lint` / `npm run dev`.

- [ ] **Step 1: Confirm the env symlink exists**

Run: `ls -la .env.local`
Expected: a symlink pointing at the main worktree's `.env.local`. If missing, create it:
```bash
ln -sf "$(git worktree list --porcelain | awk '/^worktree/{print $2; exit}')/.env.local" .env.local
```

- [ ] **Step 2: Install dependencies**

Run: `npm install`
Expected: completes without error; `node_modules/next` and `node_modules/@tanstack/react-query` exist.

- [ ] **Step 3: Establish a clean baseline**

Run: `npm run build && npm run lint`
Expected: both succeed. If the baseline is already broken, STOP and report — do not start fixes on a red baseline.

- [ ] **Step 4: Verify the Next.js docs are present for later tasks**

Run: `ls node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/loading.md node_modules/next/dist/docs/01-app/02-guides/lazy-loading.md`
Expected: both paths exist (Tasks 8–12 must read them).

- [ ] **Step 5: Checkpoint** — baseline green, no files changed. (No git.)

---

## Task 1: Query keys — `auth` domain + finance keys (A.0)

**Files:**
- Modify: `lib/query-keys.ts`

**Interfaces:**
- Produces:
  - `queryKeys.auth.all(): readonly ["auth"]`
  - `queryKeys.auth.me(): readonly ["auth", "me"]`
  - `queryKeys.finance.chartOfAccounts(): readonly ["finance", "chart-of-accounts"]`
  - `queryKeys.finance.statements(year: number, view: string): readonly ["finance", "statements", number, string]`

- [ ] **Step 1: Add the `auth` domain block**

In `lib/query-keys.ts`, immediately after the opening `export const queryKeys = {` line (line 13) and before the `// ─── Production ───` comment, insert:

```ts
  // ─── Auth ────────────────────────────────────────────────────────────────
  auth: {
    all: () => ["auth"] as const,
    me:  () => ["auth", "me"] as const,
  },

```

- [ ] **Step 2: Add the two finance keys**

In the existing `finance:` block (after `ledgerInvoices:` at line 76, before the closing `},` of `finance`), add:

```ts
    /** Flat chart-of-accounts list (invoice line-item GL mapping). */
    chartOfAccounts: () => ["finance", "chart-of-accounts"] as const,
    /** P&L / cash-flow statement aggregation, keyed by year + view. */
    statements: (year: number, view: string) => ["finance", "statements", year, view] as const,
```

- [ ] **Step 3: Typecheck**

Run: `npm run build`
Expected: PASS (registry is type-only; no consumers yet).

- [ ] **Step 4: Lint**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 5: Checkpoint** — keys exist, build+lint green. (No git.)

---

## Task 2: Cache `useUserRole` via `useAuthMeQuery` (#1, HIGH)

**Files:**
- Modify: `lib/hooks/useUserRole.ts`

**Interfaces:**
- Consumes: `queryKeys.auth.me()` (Task 1); `fetchJson` from `@/app/production/hooks/queries`.
- Produces:
  - `useAuthMeQuery()` → `UseQueryResult<Me>` where `Me = { user: { id: string; email: string } | null; role: UserRole | null }`.
  - `useUserRole(): Me & { loading: boolean }` — **unchanged public shape**.

- [ ] **Step 1: Rewrite the file**

Replace the entire contents of `lib/hooks/useUserRole.ts` with:

```ts
"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/app/production/hooks/queries";
import { queryKeys } from "@/lib/query-keys";
import type { UserRole } from "@/lib/auth";

interface Me {
  user: { id: string; email: string } | null;
  role: UserRole | null;
}

/**
 * Shared auth query. NavBar, SubNav, and the active tab all call useUserRole;
 * TanStack Query dedups them into one in-flight `/api/auth/me` request and
 * serves the rest from cache. Role is stable for the session, so it never
 * goes stale on its own (invalidate queryKeys.auth.all() on sign-in/out).
 */
export function useAuthMeQuery() {
  return useQuery({
    queryKey: queryKeys.auth.me(),
    queryFn: () => fetchJson<Me>("/api/auth/me"),
    staleTime: Infinity,
  });
}

export function useUserRole(): Me & { loading: boolean } {
  const { data, isLoading } = useAuthMeQuery();
  return {
    user: data?.user ?? null,
    role: data?.role ?? null,
    loading: isLoading,
  };
}
```

> **Note:** The old version returned `loading: true` until the fetch settled and `user/role: null` meanwhile. The new version returns `isLoading` (true only on first load with no cached data) and the same `null` defaults — identical observable behavior for all 10 consumers. Do not change any consumer.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: PASS. If any consumer breaks on types, the return shape drifted — revert and re-check Step 1.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 4: Manual check (spec #1)**

Run `npm run dev`. Open a production page with DevTools → Network filtered to `me`. Hard-reload.
Expected: `/api/auth/me` fires **exactly once** (previously 3–6 times). Navigate between tabs — it does not refire (served from cache, `staleTime: Infinity`).

- [ ] **Step 5: Checkpoint** — single auth request confirmed, build+lint green. (No git.)

---

## Task 3: Finance query hooks module (A.0b)

**Files:**
- Create: `app/finance/hooks/queries.ts`

**Interfaces:**
- Consumes: `queryKeys.finance.chartOfAccounts()`, `queryKeys.finance.statements()` (Task 1); `fetchJson` from `@/app/production/hooks/queries`; `AccountBalanceMoM` and `AccountBalance` types from `@/app/api/finance/statements/route`.
- Produces:
  - `interface CoARef { id: string; account_name: string; account_number: string | null; account_type: string }` (exported).
  - `useChartOfAccountsQuery()` → `UseQueryResult<CoARef[]>`.
  - `useStatementsQuery(year: number, view: "mom" | "cash")` → `UseQueryResult<{ year: number; accounts: AccountBalanceMoM[] }>`.
  - `useBalanceSheetQuery(year: number, month: number)` → `UseQueryResult<{ year: number; accounts: AccountBalance[] }>`.

- [ ] **Step 1: Create the module**

Create `app/finance/hooks/queries.ts`:

```ts
"use client";

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { fetchJson } from "@/app/production/hooks/queries";
import type { AccountBalanceMoM, AccountBalance } from "@/app/api/finance/statements/route";

/** Chart-of-accounts reference row (invoice line-item GL mapping). */
export interface CoARef {
  id: string;
  account_name: string;
  account_number: string | null;
  account_type: string;
}

export function useChartOfAccountsQuery() {
  return useQuery({
    queryKey: queryKeys.finance.chartOfAccounts(),
    queryFn: () => fetchJson<CoARef[]>("/api/finance/chart-of-accounts"),
  });
}

interface StatementsMoMResponse {
  year: number;
  accounts: AccountBalanceMoM[];
}

/**
 * P&L (view="mom") and Cash-Flow (view="cash") share the month-over-month
 * shape and the same year+view cache key, so switching views or revisiting a
 * year within the 30s window hits cache instead of re-running the heavy
 * pos_line_items + invoice_line_items aggregation.
 */
export function useStatementsQuery(year: number, view: "mom" | "cash") {
  return useQuery({
    queryKey: queryKeys.finance.statements(year, view),
    queryFn: () => fetchJson<StatementsMoMResponse>(`/api/finance/statements?view=${view}&year=${year}`),
  });
}

interface StatementsBalanceResponse {
  year: number;
  accounts: AccountBalance[];
}

/**
 * Balance sheet uses cumulative balances and an extra `month` selector, so its
 * URL params differ from the MoM views. `month` is folded into the cache key to
 * avoid collisions between different as-of dates within the same year.
 */
export function useBalanceSheetQuery(year: number, month: number) {
  const params = new URLSearchParams({ year: String(year), cumulative: "true" });
  if (month > 0) params.set("month", String(month));
  return useQuery({
    queryKey: [...queryKeys.finance.statements(year, "balance"), month] as const,
    queryFn: () => fetchJson<StatementsBalanceResponse>(`/api/finance/statements?${params}`),
  });
}
```

> **Why a `useBalanceSheetQuery` wrapper (spec gave the choice):** the spec said balance-sheet "builds its params differently — pass through a small wrapper hook variant or call useQuery directly." We take the wrapper variant so **all finance fetching lives in one module** (CLAUDE.md: shared logic in one place) and so `month` is part of the cache key — using bare `statements(year, "balance")` would collide across months and serve a stale as-of date.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: PASS. Confirms `AccountBalanceMoM` / `AccountBalance` are exported from the statements route (they are — the pages import them today).

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 4: Checkpoint** — hooks compile, no consumers yet, build+lint green. (No git.)

---

## Task 4: Statement pages onto query hooks (#4, MEDIUM)

**Files:**
- Modify: `app/finance/statements/pl/page.tsx`
- Modify: `app/finance/statements/cash-flow/page.tsx`
- Modify: `app/finance/statements/balance-sheet/page.tsx`

**Interfaces:**
- Consumes: `useStatementsQuery`, `useBalanceSheetQuery` from `@/app/finance/hooks/queries` (Task 3).

### 4a — P&L page

- [ ] **Step 1: Swap imports**

In `app/finance/statements/pl/page.tsx`, change the React import (line 2) from:
```ts
import { useState, useEffect, useCallback } from "react";
```
to:
```ts
import { useState, useCallback } from "react";
import { useStatementsQuery } from "@/app/finance/hooks/queries";
```

- [ ] **Step 2: Replace the data layer**

Delete these state declarations (lines 258–260):
```ts
  const [data, setData] = useState<{ year: number; accounts: AccountBalanceMoM[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
```
and delete the entire `useEffect(() => { async function load() … }, [year]);` block (lines 266–280).

Insert in their place (right after the remaining `const [year, setYear] = useState(currentYear);`):
```ts
  const { data, isFetching: loading, error: queryError } = useStatementsQuery(year, "mom");
  const error = queryError instanceof Error ? queryError.message : queryError ? "Failed to load" : null;
```

> `data` keeps the same shape (`{ year; accounts } | undefined`); `accounts = data?.accounts ?? []` at line 288 still works. `loading`/`error` are now derived names so the JSX (`{loading && …}`, `{error && …}`) is untouched.

- [ ] **Step 3: Build, lint**

Run: `npm run build && npm run lint`
Expected: PASS. (`AccountBalanceMoM` is still imported as a type for the tree code — leave that import.)

### 4b — Cash-Flow page

- [ ] **Step 4: Apply the identical transform**

In `app/finance/statements/cash-flow/page.tsx`: change line 2 to drop `useEffect` and add `import { useStatementsQuery } from "@/app/finance/hooks/queries";`. Delete the `data`/`loading`/`error` `useState`s (lines 203–205) and the `useEffect` load block (lines 209–221). Insert after `const [year, setYear] = useState(currentYear);`:
```ts
  const { data, isFetching: loading, error: queryError } = useStatementsQuery(year, "cash");
  const error = queryError instanceof Error ? queryError.message : queryError ? "Failed to load" : null;
```
Keep the `useCallback` for `handleExpandAll` and its eslint-disable comment as-is.

- [ ] **Step 5: Build, lint**

Run: `npm run build && npm run lint`
Expected: PASS.

### 4c — Balance-Sheet page

- [ ] **Step 6: Swap imports**

In `app/finance/statements/balance-sheet/page.tsx`, change line 2 to drop `useEffect` and add:
```ts
import { useBalanceSheetQuery } from "@/app/finance/hooks/queries";
```

- [ ] **Step 7: Replace the data layer (note: keeps `month`)**

Delete the `data`/`loading`/`error` `useState`s (lines 191–193) and the `useEffect` load block (lines 197–211). Insert after `const [month, setMonth] = useState(currentMonth);`:
```ts
  const { data, isFetching: loading, error: queryError } = useBalanceSheetQuery(year, month);
  const error = queryError instanceof Error ? queryError.message : queryError ? "Failed to load" : null;
```
`accounts = data?.accounts ?? []` (line 219) is unchanged. Keep the `AccountBalance` type import and the `handleExpandAll` `useCallback`.

- [ ] **Step 8: Build, lint**

Run: `npm run build && npm run lint`
Expected: PASS.

- [ ] **Step 9: Manual check (spec #4)**

`npm run dev`, DevTools → Network filtered to `statements`. Pick a year on P&L; switch P&L → Cash-Flow → Balance-Sheet and back **within 30s**.
Expected: P&L↔Cash-Flow for the same year reuse cache (no refire within the window). Balance-Sheet refires when you change **month** (distinct cache key) but not when you return to the same year+month within 30s.

- [ ] **Step 10: Checkpoint** — three pages on the query layer, build+lint green. (No git.)

---

## Task 5: Invoices CoA + batches onto query hooks (#6, MEDIUM)

**Files:**
- Modify: `app/finance/invoices/page.tsx`

**Interfaces:**
- Consumes: `useChartOfAccountsQuery`, `CoARef` from `@/app/finance/hooks/queries` (Task 3); `useBatchesQuery` from `@/app/production/hooks/queries` (existing).

- [ ] **Step 1: Add imports, drop the local `CoARef`**

In `app/finance/invoices/page.tsx`, the existing line 5 is `import { fetchJson } from "@/app/production/hooks/queries";`. Change it to:
```ts
import { fetchJson, useBatchesQuery } from "@/app/production/hooks/queries";
import { useChartOfAccountsQuery, type CoARef } from "@/app/finance/hooks/queries";
```
Then **delete** the local declaration at line 35:
```ts
interface CoARef { id: string; account_name: string; account_number: string | null; account_type: string }
```
(The imported `CoARef` is structurally identical and used by `CoASelect`, `InvoiceLineItemRow`, and the `InvoiceLineItemRow` interface's `chart_of_accounts` field.)

- [ ] **Step 2: Widen the local `BrewBatch.batch_number` to match the source**

The production `BrewBatch.batch_number` is `string | null`, but the local subtype (lines 366–371) declares `number | null`. Change line 368 from:
```ts
  batch_number: number | null;
```
to:
```ts
  batch_number: string | null;
```
All usages (`b.batch_number != null ? `#${b.batch_number}`…` in `BatchLinkEditor`) are string-safe. **Leave** `BatchLink.brew_batches.batch_number` (line 377) as `number | null` — it comes from the unrelated invoice-batch-links API.

- [ ] **Step 3: Replace the state + effect with query hooks**

Delete the two `useState`s (lines 559–560):
```ts
  const [accounts,     setAccounts]     = useState<CoARef[]>([]);
  const [batches,      setBatches]      = useState<BrewBatch[]>([]);
```
Delete the entire data-loading `useEffect` (lines 565–576).

Insert, right after the remaining filter/sort `useState`s (just before `async function handleAutoMap`):
```ts
  const { data: accounts = [] } = useChartOfAccountsQuery();
  const { data: batchRows = [] } = useBatchesQuery();
  // Project to the 4 fields this page uses (shares cache with the production area).
  const batches: BrewBatch[] = batchRows.map((b) => ({
    id: b.id,
    batch_number: b.batch_number,
    beer_name: b.beer_name,
    planned_brew_date: b.planned_brew_date,
  }));
```

> `useEffect` is still imported and used by `CoASelect`, `BatchLinkEditor`, and `InvoiceSyncPanel` — keep the React import line (64) as-is. `refetch` (from the invoices `useQuery`) is unaffected.

- [ ] **Step 4: Build, lint**

Run: `npm run build && npm run lint`
Expected: PASS. If `useBatchesQuery`'s `BrewBatch.planned_brew_date` (`string`) vs local (`string | null`) complains, it won't — `string` is assignable to `string | null`.

- [ ] **Step 5: Manual check (spec #6)**

`npm run dev`, DevTools → Network. Load the invoices page.
Expected: a single `/api/finance/chart-of-accounts` and a single `/api/production/batches`. Then navigate to the production area and back to invoices — `/api/production/batches` is served from the shared cache (no refire within 30s).

- [ ] **Step 6: Checkpoint** — CoA + batches on the query layer, batch cache shared with production, build+lint green. (No git.)

---

## Task 6: Hoist the `allInvoices` projection (#7, LOW)

**Files:**
- Modify: `app/finance/invoices/page.tsx`

> **Runs after Task 5 — same file. Never concurrent with Task 5.**

**Interfaces:**
- Consumes: `raw` (the invoices `useQuery` result) and the `InvoiceSummary` type (already declared at line 147).

- [ ] **Step 1: Build the projection once, above the table**

Currently the projection is rebuilt inside the per-row `.map` (line 781), making it O(rows²). Add a single hoisted `const` near the other derived values — right after the `unlinkedCount` computation (line 637), before `return (`:

```ts
  // Built once and shared by every row (React Compiler memoizes this call site).
  const allInvoices: InvoiceSummary[] = (raw ?? []).map((i) => ({
    id: i.id,
    invoice_number: i.invoice_number ?? null,
    square_invoice_id: i.square_invoice_id ?? null,
    invoice_date: i.invoice_date ?? null,
    customer_name: i.customer_name ?? null,
    status: i.status,
  }));
```

- [ ] **Step 2: Pass the shared reference**

At the `<InvoiceExpandableRow>` render (line 781), replace:
```tsx
                    allInvoices={(raw ?? []).map((i) => ({ id: i.id, invoice_number: i.invoice_number ?? null, square_invoice_id: i.square_invoice_id ?? null, invoice_date: i.invoice_date ?? null, customer_name: i.customer_name ?? null, status: i.status }))}
```
with:
```tsx
                    allInvoices={allInvoices}
```

> Do NOT wrap `allInvoices` in `useMemo` — React Compiler handles it.

- [ ] **Step 3: Build, lint**

Run: `npm run build && npm run lint`
Expected: PASS.

- [ ] **Step 4: Manual check (spec #7 — regression only)**

`npm run dev`, open invoices, expand a deposit invoice row. The "delivery invoice" dropdown still lists every other invoice (the `allInvoices.filter((i) => i.id !== inv.id)` at line 247 is unchanged). Table renders identically to before.

- [ ] **Step 5: Checkpoint** — projection hoisted, no behavior change, build+lint green. (No git.)

---

## Task 7: Remove dead `@uiw/react-md-editor` (#2, MEDIUM)

**Files:**
- Modify: `package.json`, `package-lock.json`

**Interfaces:** none.

- [ ] **Step 1: Re-confirm zero source imports**

Run: `grep -rn "@uiw/react-md-editor" app lib components 2>/dev/null; echo "exit=$?"`
Expected: no matches (exit non-zero). If anything matches, STOP — the dependency is in use; do not remove it.

- [ ] **Step 2: Uninstall**

Run: `npm uninstall @uiw/react-md-editor`
Expected: `package.json` line 16 removed; lockfile updated.

- [ ] **Step 3: Build, lint**

Run: `npm run build && npm run lint`
Expected: PASS.

- [ ] **Step 4: Manual check (spec #2)**

Run: `npm ls @uiw/react-md-editor`
Expected: reports the package is not installed (empty / "(empty)"). Build already succeeded in Step 3.

- [ ] **Step 5: Checkpoint** — dependency gone, build+lint green. (No git.)

---

## Task 8: Lazy-load SalesPulse chart + shared ChartSkeleton (#3a, MEDIUM)

**Files:**
- Create: `app/components/ChartSkeleton.tsx`
- Create: `app/taproom/components/SalesPulseChart.tsx`
- Modify: `app/taproom/components/SalesPulseTab.tsx`

> **Read first:** `node_modules/next/dist/docs/01-app/02-guides/lazy-loading.md` (AGENTS.md requirement). `ssr: false` is valid here because every file is `"use client"`.

**Interfaces:**
- Produces: `ChartSkeleton` (default export, prop `{ height?: number }`) — imported by Tasks 9 and 10; `SalesPulseChart` (default export).

- [ ] **Step 1: Create the shared skeleton**

Create `app/components/ChartSkeleton.tsx`:
```tsx
export default function ChartSkeleton({ height = 280 }: { height?: number }) {
  return (
    <div
      className="w-full animate-pulse rounded-lg bg-zinc-900/40"
      style={{ height }}
      aria-hidden="true"
    />
  );
}
```

- [ ] **Step 2: Create `SalesPulseChart.tsx` with the extracted recharts subtree**

This is a mechanical extraction. Create `app/taproom/components/SalesPulseChart.tsx` containing: the recharts imports (currently SalesPulseTab lines 6–9), the `ChartTooltip` component (currently lines 107–131), a local `formatCurrency` (the tooltip needs it), the `KpiMetric` type, and the `<ResponsiveContainer>…</ResponsiveContainer>` JSX (currently lines 359–400) wrapped in a default-exported component:

```tsx
"use client";

import {
  ResponsiveContainer, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from "recharts";
import { formatCurrencyCents } from "@/lib/format";

type KpiMetric = "net_sales" | "gross_sales" | "avg_ticket" | "guest_count";

function ChartTooltip({
  active, payload, label, metric,
}: {
  active?: boolean;
  payload?: { name: string; value: number; color: string; strokeDasharray?: string }[];
  label?: string;
  metric: KpiMetric;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-xs shadow-lg">
      <div className="text-zinc-300 font-medium mb-1">{label}</div>
      {payload.map((p) => (
        <div key={p.name} style={{ color: p.color }} className="flex justify-between gap-4">
          <span>{p.name}</span>
          <span className="font-mono">
            {metric === "guest_count"
              ? Math.round(p.value ?? 0).toLocaleString()
              : formatCurrencyCents((p.value ?? 0) * 100, 0)}
          </span>
        </div>
      ))}
    </div>
  );
}

export interface SalesPulseChartDatum {
  day: string;
  "This Week"?: number;
  "Prior Week"?: number;
}

export default function SalesPulseChart({
  chartData, chartMetric,
}: {
  chartData: SalesPulseChartDatum[];
  chartMetric: KpiMetric;
}) {
  const yAxisFmt = (v: number) => {
    if (chartMetric === "guest_count") return String(v);
    if (v >= 1000) return `$${(v / 1000).toFixed(0)}k`;
    return `$${v.toFixed(0)}`;
  };

  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#3f3f46" vertical={false} />
        <XAxis
          dataKey="day"
          tick={{ fill: "#a1a1aa", fontSize: 11 }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tickFormatter={yAxisFmt}
          tick={{ fill: "#a1a1aa", fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          width={44}
        />
        <Tooltip content={<ChartTooltip metric={chartMetric} />} />
        <Legend
          wrapperStyle={{ fontSize: 12, color: "#a1a1aa", paddingTop: 8 }}
          formatter={(value) => <span style={{ color: "#a1a1aa" }}>{value}</span>}
        />
        <Line
          type="monotone"
          dataKey="This Week"
          stroke="#f59e0b"
          strokeWidth={2}
          dot={{ r: 4, fill: "#f59e0b", strokeWidth: 0 }}
          activeDot={{ r: 5 }}
          connectNulls={false}
        />
        <Line
          type="monotone"
          dataKey="Prior Week"
          stroke="#60a5fa"
          strokeWidth={2}
          strokeDasharray="5 4"
          dot={{ r: 3, fill: "#60a5fa", strokeWidth: 0 }}
          activeDot={{ r: 4 }}
          connectNulls={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
```

> No formatter is duplicated — the chunk imports `formatCurrencyCents` from the shared `@/lib/format`. The parent tab keeps its own local `formatCurrency` (which itself delegates to `@/lib/format`) for the KPI cards and category table; that is unaffected.

- [ ] **Step 3: Wire the parent to lazy-load it**

In `app/taproom/components/SalesPulseTab.tsx`:
- **Remove** the recharts import block (lines 6–9).
- **Remove** the `ChartTooltip` component (lines 107–131).
- Add near the top imports:
  ```ts
  import dynamic from "next/dynamic";
  import ChartSkeleton from "@/app/components/ChartSkeleton";

  const SalesPulseChart = dynamic(() => import("./SalesPulseChart"), {
    ssr: false,
    loading: () => <ChartSkeleton height={280} />,
  });
  ```
- Replace the `<ResponsiveContainer>…</ResponsiveContainer>` block (lines 359–400) with:
  ```tsx
  <SalesPulseChart chartData={chartData} chartMetric={chartMetric} />
  ```
- The local `formatCurrency` (line 76) stays (used by `formatMetricValue` + category table). `yAxisFmt` (lines 237–241) is now only referenced inside the chart — **delete it from the tab** to avoid an unused-var lint error.

- [ ] **Step 4: Build, lint**

Run: `npm run build && npm run lint`
Expected: PASS. Lint will catch any now-unused import/var (e.g. leftover `yAxisFmt`) — remove what it flags.

- [ ] **Step 5: Manual check (spec #3)**

`npm run dev`, DevTools → Network filtered to JS chunks. Load a page that does NOT show this tab; confirm no recharts chunk loads. Open the SalesPulse tab; confirm the recharts chunk loads **then**, and the skeleton flashes before the chart paints.

- [ ] **Step 6: Checkpoint** — chart code-split, skeleton shows, build+lint green. (No git.)

---

## Task 9: Lazy-load DraftStats chart (#3b, MEDIUM)

**Files:**
- Create: `app/taproom/components/DraftStatsChart.tsx`
- Modify: `app/taproom/components/DraftStatsTab.tsx`

> Depends on Task 8 (`ChartSkeleton`). `ssr: false` valid — file is `"use client"`.

**Interfaces:**
- Consumes: `ChartSkeleton` (Task 8).

- [ ] **Step 1: Create `DraftStatsChart.tsx`**

Extract the recharts subtree (DraftStatsTab lines 450–482) plus the recharts imports (lines 6–9). The chart needs `chartData` and `chartByShrinkageItem` (for the `Cell` color lookup). The tooltip is inline (no separate component). Create:

```tsx
"use client";

import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell,
} from "recharts";

interface ChartDatum { date: string; recipe: string; shrinkage_fl_oz: number; shrinkage_pct: number }
interface ShrinkageColorItem { beer_name: string; color: string }

export default function DraftStatsChart({
  chartData, chartByShrinkageItem,
}: {
  chartData: ChartDatum[];
  chartByShrinkageItem: ShrinkageColorItem[];
}) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={chartData} margin={{ top: 5, right: 16, left: 0, bottom: 20 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#3f3f46" />
        <XAxis
          dataKey="date"
          tick={{ fill: "#a1a1aa", fontSize: 11 }}
          tickLine={{ stroke: "#52525b" }}
          axisLine={{ stroke: "#52525b" }}
          angle={-30} textAnchor="end" height={45}
        />
        <YAxis
          tick={{ fill: "#a1a1aa", fontSize: 11 }}
          tickLine={{ stroke: "#52525b" }}
          axisLine={{ stroke: "#52525b" }}
          label={{ value: "fl oz", angle: -90, position: "insideLeft", fill: "#71717a", fontSize: 11, dy: 30 }}
        />
        <Tooltip
          contentStyle={{ backgroundColor: "#18181b", border: "1px solid #3f3f46", borderRadius: "6px", fontSize: 12, color: "#e4e4e7" }}
          labelStyle={{ color: "#e4e4e7", fontWeight: 600 }}
          itemStyle={{ color: "#a1a1aa" }}
          formatter={(val, _name, props) => [
            `${val} fl oz (${props.payload?.shrinkage_pct ?? 0}%)`,
            props.payload?.recipe ?? "",
          ]}
        />
        <Bar dataKey="shrinkage_fl_oz" radius={[2, 2, 0, 0]}>
          {chartData.map((entry, idx) => {
            const color = chartByShrinkageItem.find((i) => i.beer_name === entry.recipe)?.color ?? "#a1a1aa";
            return <Cell key={idx} fill={color} fillOpacity={0.8} />;
          })}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
```

> `Legend` is NOT imported here — the on-page legend (DraftStatsTab lines 484–492) lives outside the `ResponsiveContainer` and stays in the parent. Drop `Legend` from the recharts import when removing it from the tab.

- [ ] **Step 2: Wire the parent**

In `app/taproom/components/DraftStatsTab.tsx`:
- **Remove** the recharts import block (lines 6–9).
- Add near the top imports:
  ```ts
  import dynamic from "next/dynamic";
  import ChartSkeleton from "@/app/components/ChartSkeleton";

  const DraftStatsChart = dynamic(() => import("./DraftStatsChart"), {
    ssr: false,
    loading: () => <ChartSkeleton height={260} />,
  });
  ```
- Replace the `<ResponsiveContainer>…</ResponsiveContainer>` block (lines 450–482) with:
  ```tsx
  <DraftStatsChart chartData={chartData} chartByShrinkageItem={chartByShrinkageItem} />
  ```
  (The surrounding `<div className="rounded-lg border …">`, the `<h4>` heading, and the legend `<div>` all stay.)

- [ ] **Step 3: Build, lint**

Run: `npm run build && npm run lint`
Expected: PASS.

- [ ] **Step 4: Manual check (spec #3)**

`npm run dev`. Open the DraftStats tab; confirm the recharts chunk loads on open (not on initial app load) and the skeleton shows first. Bars render with correct per-recipe colors.

- [ ] **Step 5: Checkpoint** — chart code-split, build+lint green. (No git.)

---

## Task 10: Lazy-load Achievement chart (#3c, MEDIUM)

**Files:**
- Create: `app/taproom/components/AchievementChart.tsx`
- Modify: `app/taproom/components/AchievementTab.tsx`

> Depends on Task 8 (`ChartSkeleton`). `ssr: false` valid — file is `"use client"`.

**Interfaces:**
- Consumes: `ChartSkeleton` (Task 8).

- [ ] **Step 1: Create `AchievementChart.tsx`**

Extract the recharts subtree (AchievementTab lines 473–516) plus the recharts imports (lines 7–10), the `ChartTooltip` (lines 117–134), and a local `fmtDollars` (the tooltip needs it). The chart is driven by these already-computed values from the parent — pass them as props:

```tsx
"use client";

import {
  ResponsiveContainer, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
} from "recharts";
import { formatCurrency } from "@/lib/format";

type Grain = "monthly" | "weekly";
type ChartView = "per-period" | "cumulative";

function ChartTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: { name: string; value: number; color: string }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-xs shadow-lg">
      <div className="text-zinc-300 font-medium mb-1">{label}</div>
      {payload.map((p) => (
        <div key={p.name} style={{ color: p.color }} className="flex justify-between gap-4">
          <span>{p.name}</span>
          <span className="font-mono">{p.value != null ? formatCurrency(p.value, 0) : "—"}</span>
        </div>
      ))}
    </div>
  );
}

export interface AchievementChartDatum {
  name: string;
  "Net Sales"?: number;
  "Forecast"?: number;
  "Cumulative"?: number;
  "Forecast Total"?: number;
  _isInProgress: boolean;
}

export default function AchievementChart({
  chartData, chartView, grain, yDomain,
  perPeriodTargetDollars, cumulativeTargetDollars, activeTierColor, tierLabel,
}: {
  chartData: AchievementChartDatum[];
  chartView: ChartView;
  grain: Grain;
  yDomain: [number, number];
  perPeriodTargetDollars: number | null;
  cumulativeTargetDollars: number | null;
  activeTierColor: string;
  tierLabel: string;
}) {
  const yAxisFmt = (v: number) => v >= 1000 ? `$${(v / 1000).toFixed(0)}k` : `$${v.toFixed(0)}`;

  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={chartData}
        margin={{ top: 8, right: 16, bottom: grain === "weekly" ? 30 : 4, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#3f3f46" vertical={false} />
        <XAxis dataKey="name" interval={0}
          tick={grain === "weekly" ? { fill: "#a1a1aa", fontSize: 10, dy: 4 } : { fill: "#a1a1aa", fontSize: 11 }}
          angle={grain === "weekly" ? -45 : 0}
          textAnchor={grain === "weekly" ? "end" : "middle"}
          axisLine={false} tickLine={false}
          height={grain === "weekly" ? 52 : 24} />
        <YAxis tickFormatter={yAxisFmt} domain={yDomain}
          tick={{ fill: "#a1a1aa", fontSize: 11 }} axisLine={false} tickLine={false} width={44} />
        <Tooltip content={<ChartTooltip />} />

        {chartView === "per-period" && (
          <>
            {perPeriodTargetDollars !== null && (
              <ReferenceLine y={perPeriodTargetDollars} stroke={activeTierColor}
                strokeDasharray="5 4" strokeWidth={1.5}
                label={{ value: `Avg ${tierLabel}`, position: "insideTopRight", fill: activeTierColor, fontSize: 10 }} />
            )}
            <Line type="monotone" dataKey="Net Sales" stroke="#60a5fa" strokeWidth={2}
              dot={{ r: 4, fill: "#60a5fa", strokeWidth: 0 }} activeDot={{ r: 5 }} connectNulls={false} />
            <Line type="monotone" dataKey="Forecast" stroke="#60a5fa" strokeWidth={2}
              strokeDasharray="5 4" dot={{ r: 4, fill: "#60a5fa", strokeWidth: 0, opacity: 0.5 }}
              activeDot={{ r: 5 }} connectNulls={false} />
          </>
        )}
        {chartView === "cumulative" && (
          <>
            {cumulativeTargetDollars !== null && (
              <ReferenceLine y={cumulativeTargetDollars} stroke={activeTierColor}
                strokeDasharray="5 4" strokeWidth={1.5}
                label={{ value: tierLabel, position: "insideTopRight", fill: activeTierColor, fontSize: 10 }} />
            )}
            <Line type="monotone" dataKey="Cumulative" stroke="#34d399" strokeWidth={2}
              dot={{ r: 4, fill: "#34d399", strokeWidth: 0 }} activeDot={{ r: 5 }} connectNulls={false} />
            <Line type="monotone" dataKey="Forecast Total" stroke="#34d399" strokeWidth={2}
              strokeDasharray="5 4" dot={{ r: 4, fill: "#34d399", strokeWidth: 0, opacity: 0.5 }}
              activeDot={{ r: 5 }} connectNulls={false} />
          </>
        )}
      </LineChart>
    </ResponsiveContainer>
  );
}
```

- [ ] **Step 2: Wire the parent**

In `app/taproom/components/AchievementTab.tsx`:
- **Remove** the recharts import block (lines 7–10).
- **Remove** the `ChartTooltip` component (lines 117–134).
- Add near the top imports:
  ```ts
  import dynamic from "next/dynamic";
  import ChartSkeleton from "@/app/components/ChartSkeleton";

  const AchievementChart = dynamic(() => import("./AchievementChart"), {
    ssr: false,
    loading: () => <ChartSkeleton height={300} />,
  });
  ```
- Replace the `<ResponsiveContainer>…</ResponsiveContainer>` block (lines 473–516) with:
  ```tsx
  <AchievementChart
    chartData={chartData}
    chartView={chartView}
    grain={grain}
    yDomain={yDomain}
    perPeriodTargetDollars={perPeriodTargetDollars}
    cumulativeTargetDollars={cumulativeTargetDollars}
    activeTierColor={activeTierColor}
    tierLabel={tierLabel}
  />
  ```
- `fmtDollars` in the tab is now unused after `ChartTooltip` moves out — **delete it**. That likely makes `formatCurrency` unused in the tab's `import { … } from "@/lib/format"` line — **remove `formatCurrency` from that import** (keep `formatCurrencyCents` and `formatPercent`, still used by `currency`/`pct`). `yAxisFmt` moves into the chart — **delete it from the tab**. `currency` and `pct` stay. Run `npm run lint` and remove exactly what it flags as unused — do not guess.

- [ ] **Step 3: Build, lint**

Run: `npm run build && npm run lint`
Expected: PASS. Remove any unused-var/import flagged by lint (`fmtDollars`, `yAxisFmt`).

- [ ] **Step 4: Manual check (spec #3)**

`npm run dev`. Open the Achievement tab; confirm the recharts chunk loads on open and the skeleton shows first. Toggle Per-Period ↔ Cumulative and Monthly ↔ Weekly — lines, reference lines, and axis formatting match pre-change behavior.

- [ ] **Step 5: Checkpoint** — chart code-split, build+lint green. (No git.)

---

## Task 11: Lazy-load EquipmentSchedule (React Flow) (#3d, MEDIUM)

**Files:**
- Modify: `app/production/components/BatchLogTab.tsx`

> Independent of Tasks 8–10. `@xyflow/react` (+ its CSS) is pulled into the bundle only through this one import. `ssr: false` valid — BatchLogTab is `"use client"`.

**Interfaces:**
- Consumes: nothing new. `EquipmentScheduleSection` is a **named** export of `./EquipmentSchedule` — use the `.then((m) => m.Name)` dynamic form.

- [ ] **Step 1: Replace the static import with a dynamic one**

In `app/production/components/BatchLogTab.tsx`, delete the static import at line 21:
```ts
import { EquipmentScheduleSection } from "./EquipmentSchedule";
```
Add `import dynamic from "next/dynamic";` to the import block (near the `import React, { useState } from "react";` at line 3), and add, just below the import block:
```tsx
const EquipmentScheduleSection = dynamic(
  () => import("./EquipmentSchedule").then((m) => m.EquipmentScheduleSection),
  {
    ssr: false,
    loading: () => <div className="h-64 w-full animate-pulse rounded-lg bg-zinc-900/40" aria-hidden="true" />,
  }
);
```

> Leave the usage at line 1359 (`<EquipmentScheduleSection … />`) and the separate `computeBranchPackagingStatus` import from `./EquipmentSchedule/constants` (line 22) untouched — `constants` does not pull in `@xyflow/react`.

- [ ] **Step 2: Build, lint**

Run: `npm run build && npm run lint`
Expected: PASS. If TS complains about prop types on the dynamic component, ensure the `.then((m) => m.EquipmentScheduleSection)` form is used (preserves the prop signature).

- [ ] **Step 3: Manual check (spec #3)**

`npm run dev`, DevTools → Network filtered to JS. Load the production area on a tab other than Batch Log; confirm no `@xyflow`/react-flow chunk loads. Open Batch Log and expand a batch that renders the schedule; confirm the React Flow chunk loads **then**, with the skeleton showing first. The graph renders and is interactive.

- [ ] **Step 4: Checkpoint** — React Flow code-split, build+lint green. (No git.)

---

## Task 12: Route loading skeletons (#5, MEDIUM)

**Files:**
- Create: `app/finance/statements/loading.tsx`
- Create: `app/finance/invoices/loading.tsx`
- Create: `app/production/loading.tsx`

> **Read first:** `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/loading.md` (AGENTS.md requirement). `loading.tsx` is a **Server Component** by default and wraps the segment's `page.tsx` (and nested children) in a `<Suspense>` boundary — so `app/finance/statements/loading.tsx` covers the `pl`/`cash-flow`/`balance-sheet` child routes too.

**Interfaces:** none (Next.js file convention; default-exported `Loading` component, no props).

- [ ] **Step 1: Statements skeleton**

Create `app/finance/statements/loading.tsx` (a table-shaped shimmer matching the dark theme; no `"use client"`):
```tsx
export default function Loading() {
  return (
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-100">
      <div className="shrink-0 px-4 sm:px-6 pt-4 sm:pt-5 pb-3">
        <div className="h-5 w-48 rounded bg-zinc-800/70 animate-pulse" />
        <div className="mt-2 h-3 w-72 rounded bg-zinc-900 animate-pulse" />
      </div>
      <div className="flex-1 overflow-hidden px-4 sm:px-6 py-4 space-y-2">
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} className="h-7 w-full rounded bg-zinc-900/60 animate-pulse" />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Invoices skeleton**

Create `app/finance/invoices/loading.tsx`:
```tsx
export default function Loading() {
  return (
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-100">
      <div className="shrink-0 px-4 sm:px-6 pt-4 sm:pt-6 pb-4">
        <div className="h-6 w-40 rounded bg-zinc-800/70 animate-pulse" />
        <div className="mt-2 h-3 w-80 rounded bg-zinc-900 animate-pulse" />
      </div>
      <div className="flex-1 overflow-hidden px-4 sm:px-6 py-4">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-2">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="h-8 w-full rounded bg-zinc-900/70 animate-pulse" />
          ))}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Production skeleton**

Create `app/production/loading.tsx` (the production shell is a tabbed grid; a header + grid shimmer reads correctly):
```tsx
export default function Loading() {
  return (
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-100">
      <div className="shrink-0 px-4 sm:px-6 pt-4 sm:pt-5 pb-3">
        <div className="h-5 w-44 rounded bg-zinc-800/70 animate-pulse" />
      </div>
      <div className="flex-1 overflow-hidden px-4 sm:px-6 py-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {Array.from({ length: 9 }).map((_, i) => (
          <div key={i} className="h-28 rounded-lg bg-zinc-900/60 animate-pulse" />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Build, lint**

Run: `npm run build && npm run lint`
Expected: PASS.

- [ ] **Step 5: Manual check (spec #5)**

`npm run dev`. Navigate to `/finance/statements/pl`, `/finance/invoices`, and `/production` (ideally with Network throttled to "Slow 3G").
Expected: each route shows its skeleton instantly on navigation, then swaps to real content once the segment resolves.

- [ ] **Step 6: Checkpoint** — three skeletons render, build+lint green. (No git.)

---

## Final verification (all tasks complete)

- [ ] **Full build:** `npm run build` — clean.
- [ ] **Full lint:** `npm run lint` — clean.
- [ ] **Existing unit tests still pass:** `npm run test` — the `lib/` vitest suite is unaffected; confirm it stays green.
- [ ] **Spec verification table walk-through** (`npm run dev`, DevTools open):
  - #1 `/api/auth/me` fires once per production-page load.
  - #4 same-year P&L↔Cash-Flow view switches reuse cache within 30s.
  - #6 single `/api/finance/chart-of-accounts` + single `/api/production/batches`; batches reused after visiting production.
  - #2 `npm ls @uiw/react-md-editor` → not found.
  - #3 recharts and `@xyflow` chunks load only when their tab opens.
  - #5 skeletons render on navigation to statements / invoices / production.
  - #7 invoices table renders identically; delivery dropdown unchanged.
- [ ] **Report results to the user. Do NOT commit, stage, or push** — await explicit instruction.

---

## Self-Review

**1. Spec coverage** — every fix maps to a task:
- A.0 keys → Task 1 ✓ · A.0b hooks → Tasks 2 (auth) + 3 (finance) ✓ · #1 → Task 2 ✓ · #4 → Task 4 ✓ · #6 → Task 5 ✓ · #2 → Task 7 ✓ · #3 (recharts ×3 + xyflow) → Tasks 8/9/10/11 ✓ · #5 → Task 12 ✓ · #7 → Task 6 ✓. Setup (`npm install`, missing `node_modules`) → Task 0. Spec item #8 explicitly out of scope — no task. ✓

**2. Placeholder scan** — every code step shows complete code; manual checks are concrete (named requests, named routes). No "TBD"/"add error handling"/"similar to Task N". The only "read the file and remove what lint flags" instructions are paired with the specific candidates (`yAxisFmt`, `fmtDollars`) and a lint gate — not open-ended. ✓

**3. Type consistency** — `Me` shape identical in Task 2 hook and `useUserRole`. `CoARef` defined once (Task 3), imported by Task 5 (local dup deleted). `useStatementsQuery(year, "mom"|"cash")` and `useBalanceSheetQuery(year, month)` signatures match their call sites in Task 4. `BrewBatch.batch_number` widened to `string | null` in Task 5 to match the production source type. Chart prop interfaces (`SalesPulseChartDatum`, `AchievementChartDatum`, DraftStats inline) match the parent's computed `chartData` shapes verified against live source. `ChartSkeleton`'s `{ height?: number }` matches all three `loading: () => <ChartSkeleton height={…} />` call sites. ✓

**Deviation from skill defaults (justified):** (a) No per-task `git commit` — user explicitly said "stage nothing until I say so." (b) No TDD unit tests — no `@testing-library/react` is installed and these fixes add no pure-logic functions; verification is build + lint + the spec's manual checks, per the spec itself. Both are user/spec instructions taking precedence over the skill template.

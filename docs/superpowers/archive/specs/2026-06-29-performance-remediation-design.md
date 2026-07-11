# Performance Remediation — Design Spec

**Date:** 2026-06-29
**Status:** Approved (design), pending implementation plan
**Scope:** 7 fixes from the 2026-06-29 performance audit. Stretch item #8 (server-rendering the statement pages) is explicitly **out of scope** and may become its own later spec.

---

## Context

The app already has the right primitives in place:

- **React Compiler is enabled globally** (`next.config.ts`: `reactCompiler: true`), so manual `useMemo`/`React.memo` work is unnecessary — the compiler auto-memoizes. None of the fixes below add manual memoization.
- **TanStack Query is the primary data layer** (`app/providers.tsx`: 30s `staleTime`, `refetchOnWindowFocus: false`). Three code paths bypass it with raw `useEffect` + `fetch`; the highest-ROI work is moving those onto the existing layer.
- **Square catalog reads are already cached** (`lib/square/catalog.ts`, `unstable_cache`, `revalidate: 300`, tag `square-catalog`). No server-cache changes are needed.

**Guiding principle (from CLAUDE.md):** *build for extension.* The React Query work introduces **shared, reusable hooks** colocated with the existing query hooks — not one-off fetches — so a third and fourth consumer reuse them.

---

## Fix inventory

| # | Group | Fix | Severity |
|---|-------|-----|----------|
| 1 | A | Cache `useUserRole` via a shared `useAuthMeQuery` | HIGH |
| 4 | A | Move the three statement pages onto `useStatementsQuery` | MEDIUM |
| 6 | A | Move invoices CoA + batches onto query hooks | MEDIUM |
| 2 | B | Remove dead `@uiw/react-md-editor` dependency | MEDIUM |
| 3 | B | Lazy-load recharts tabs + EquipmentSchedule via `next/dynamic` | MEDIUM |
| 5 | C | Add `loading.tsx` to slow route segments | MEDIUM |
| 7 | D | Hoist `allInvoices` projection out of the per-row `.map` | LOW |

---

## Group A — React Query consolidation (fixes #1, #4, #6)

**Theme:** three paths fetch with raw `useEffect`/`setState`, bypassing dedup + caching. Move them onto TanStack Query, adding shared keys and hooks.

### A.0 — New query keys (`lib/query-keys.ts`)

Add a new `auth` domain and two `finance` keys, following the existing "every key is a function" convention:

```ts
auth: {
  all: () => ["auth"] as const,
  me:  () => ["auth", "me"] as const,
},
// within finance:
chartOfAccounts: () => ["finance", "chart-of-accounts"] as const,
statements: (year: number, view: string) => ["finance", "statements", year, view] as const,
```

### A.0b — New shared hooks

All hooks use the shared `fetchJson` helper (currently exported from `app/production/hooks/queries.ts`). Concrete placement:

- **`useAuthMeQuery()`** → in `lib/hooks/useUserRole.ts` itself (or a sibling `lib/hooks/useAuthMeQuery.ts`), next to its only consumer. Key `queryKeys.auth.me()`, `fetchJson<Me>("/api/auth/me")`, `staleTime: Infinity` (role is stable for the session; explicit invalidation on sign-in/out if needed).
- **`useChartOfAccountsQuery()`** and **`useStatementsQuery(year, view)`** → a new finance query module `app/finance/hooks/queries.ts`, mirroring the existing `app/production/hooks/queries.ts` structure. Import `fetchJson` from the production queries module (as `app/finance/invoices/page.tsx` already does) or re-export it.
  - `useChartOfAccountsQuery()` → `queryKeys.finance.chartOfAccounts()`, `fetchJson<CoARef[]>("/api/finance/chart-of-accounts")`.
  - `useStatementsQuery(year, view)` → `queryKeys.finance.statements(year, view)`, `fetchJson(\`/api/finance/statements?view=${view}&year=${year}\`)`. (Balance-sheet builds its params differently — see #4.)

### A.1 — `useUserRole` (HIGH)

**File:** `lib/hooks/useUserRole.ts`

Rewrite the body to delegate to `useAuthMeQuery`. **The public return shape (`{ user, role, loading }`) must stay byte-for-byte identical** so all 10 consumers (NavBar, SubNav, BrewStatusTab, PackagingTab, IngredientsTab, BatchLogTab, ManualEntriesTab, TargetSettingTab, taproom payroll/reports pages, production calendar) require zero changes.

```ts
export function useUserRole(): Me & { loading: boolean } {
  const { data, isLoading } = useAuthMeQuery();
  return {
    user: data?.user ?? null,
    role: data?.role ?? null,
    loading: isLoading,
  };
}
```

**Why:** NavBar + SubNav (both in the root layout) plus the active tab each currently fire their own `/api/auth/me`. TanStack Query dedups concurrent callers into one in-flight request and serves the rest from cache — collapses 3–6 requests per page load to 1.

### A.4 — Statement pages (MEDIUM)

**Files:** `app/finance/statements/pl/page.tsx`, `.../cash-flow/page.tsx`, `.../balance-sheet/page.tsx`

Replace each page's `useEffect`/`setState` fetch with `useStatementsQuery`:

- P&L: `useStatementsQuery(year, "mom")`
- Cash-flow: `useStatementsQuery(year, "cash")`
- Balance-sheet: builds params differently (`?${params}`); pass its existing param string through a small wrapper hook variant or call `useQuery` directly with `queryKeys.finance.statements(year, "balance")` and the page's own URL. Keep the page's existing param-construction logic; only the fetch mechanism changes.

Loading/error states come from the query result (`isFetching`, `error`) instead of local state. Same-year view switches now hit the 30s cache instead of re-running the heavy `pos_line_items` + `invoice_line_items` aggregation.

### A.6 — Invoices CoA + batches (MEDIUM)

**File:** `app/finance/invoices/page.tsx` (the `useEffect` at ~line 565)

- Replace the `fetch("/api/finance/chart-of-accounts")` call with `useChartOfAccountsQuery()`.
- Replace the `fetch("/api/production/batches")` call with the **existing** `productionKeys.batches()` query (import the existing batches query hook), so the batch list shares cache with the production area. Keep the client-side projection to the 4 used fields (`id`, `batch_number`, `beer_name`, `planned_brew_date`).
- Remove the now-empty `useEffect` and the `accounts`/`batches` `useState`.

---

## Group B — Bundle weight (fixes #2, #3)

### B.2 — Remove dead dependency (MEDIUM)

`@uiw/react-md-editor` (^4.1.1) has **zero source imports** (verified: only `package.json` / `package-lock.json` reference it).

```
npm uninstall @uiw/react-md-editor
```

Verify `npm run build` still succeeds afterward.

### B.3 — Lazy-load heavy client libs (MEDIUM)

`next/dynamic` is currently used **nowhere** in the app, so `recharts` (~150KB gz) and `@xyflow/react` load eagerly. Establish the pattern:

- **Recharts tabs** — `app/taproom/components/SalesPulseTab.tsx`, `DraftStatsTab.tsx`, `AchievementTab.tsx`. Extract each tab's chart-rendering subtree into a child component and import it via `dynamic(() => import("./Xyz"), { ssr: false, loading: () => <ChartSkeleton /> })`. The recharts chunk then loads only when the tab is opened.
- **EquipmentSchedule** — `app/production/components/EquipmentSchedule/index.tsx` (imports `@xyflow/react` + its CSS). Load the component via `dynamic({ ssr: false })` from the production tab shell so React Flow loads only when that tab is selected.

---

## Group C — Route UX (fix #5)

No `loading.tsx` files exist anywhere. Add skeleton fallbacks to the slow segments so the App Router streams an instant placeholder on navigation:

- `app/finance/statements/loading.tsx`
- `app/finance/invoices/loading.tsx`
- `app/production/loading.tsx`

Each is a simple skeleton matching the page's layout (header + table/grid shimmer). Built-in Next.js convention — no library.

---

## Group D — Micro (fix #7)

**File:** `app/finance/invoices/page.tsx` (~line 781)

The `allInvoices={(raw ?? []).map(...)}` projection is built **inside the per-row `.map`**, rebuilding the full summary array once per rendered row (O(rows²)). Hoist it to a single `const allInvoices = useMemo`-free `const` above the `<table>` (React Compiler memoizes the call site) and pass the same reference to every `InvoiceExpandableRow`.

---

## Verification

Every fix must pass:

1. `npm run build` — clean.
2. `npm run lint` — clean.
3. A fix-specific **manual check**:

| Fix | Manual check |
|-----|--------------|
| #1 | DevTools Network panel: `/api/auth/me` fires **once** on a production-page load (previously 3–6). |
| #4 | Switching P&L → Cash-Flow → Balance-Sheet and back for the same year does not refire `/api/finance/statements` within the 30s window. |
| #6 | Invoices page issues a single `/api/production/batches` + single `/api/finance/chart-of-accounts`; navigating production then invoices reuses the cached batches. |
| #2 | `npm ls @uiw/react-md-editor` reports not found; build succeeds. |
| #3 | The recharts / xyflow chunk appears in the Network panel only after opening the relevant tab, not on initial route load. |
| #5 | Skeleton renders during navigation to each segment before data resolves. |
| #7 | No behavior change; invoices table renders identically (regression check). |

---

## Sequencing

- **Group A foundation first:** A.0 (keys) + A.0b (shared hooks) land before #1/#4/#6 consume them.
- **Groups B, C, D are independent** of A and of each other — parallelizable.
- The implementation plan (next step) details task-level ordering and which tasks can run concurrently.

## Out of scope

- Audit item #8 (convert statement pages to async Server Components with a client island). Larger refactor; separate spec if pursued.
- Narrowing shared API-route `.select()` projections (audit DB-LOW finding) — deferred; not worth touching shared routes for payload trimming now.
- Adding a virtualization library — the invoices list should follow the existing **server-side pagination** pattern from the transactions page if it grows; no new dependency.

## Dependencies

- **No new libraries.** `@tanstack/react-query` and `next/dynamic` (built-in) cover all fixes. `@uiw/react-md-editor` is **removed**.

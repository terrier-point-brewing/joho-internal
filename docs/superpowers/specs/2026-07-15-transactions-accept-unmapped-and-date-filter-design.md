# Transactions: Accept Unmapped + Date Range Filter + Filter Bar Layout — Design Spec

**Date:** 2026-07-15
**Branch:** `claude/finance-transactions-ui-e0f6fe`
**Status:** Approved design → ready for implementation plan

## Goal

Three coordinated changes across all four Finance → Transactions subtabs
(Orders, Invoices, Expenses, Bank Ledger):

1. **Manually accept an unmapped transaction** — a DB-backed per-row flag that
   dismisses a row from "unmapped" warnings/filters without requiring an
   actual GL account mapping.
2. **Start/end date filtering** — replaces the existing Year dropdown on all
   four tabs with an explicit date range, defaulting to the current calendar
   year.
3. **Filter bar layout** — every control (search, date range, mapping/status
   filters, sync, auto-map) collapses onto one line, matching the Invoices
   tab's current layout.

## Non-goals

- Changing how Financials/P&L/Balance Sheet computation treats unmapped rows
  (`app/finance/financials/**`) — this is purely a Transactions-tab warning
  dismissal, not a reclassification of the underlying data.
- Per-line-item acceptance for Orders/Invoices. Acceptance is whole-row only
  (see "Accept granularity" below).
- Changing Bank Ledger's `flow_type` classification logic — accepting a row
  only dismisses the "needs review" warning, it does not set a flow type or
  GL account.

---

## Current-state facts (verified)

- Four subtabs share `app/finance/transactions/components/{LedgerTable,
  MappingFilter, MappingStatusPill, SummaryStatBar, YearSelect, SyncPanel,
  AutoMapButton}.tsx` and the pure helper `lib/finance/mappingStatus.ts`
  (`mappingState`, `matchesMappingFilter`).
- **Orders** (`app/finance/transactions/orders/page.tsx`): fetches
  `/api/finance/transactions?year=&page=&pageSize=` — **server-paginated**
  (50/page). Mapping is per `pos_line_items` row, rolled up per order via
  `orderMapped()`. `SummaryStatBar` shows an "Unmapped line items" count
  (flat count across all loaded — i.e. current-page — orders). FilterBar
  currently holds only search/year/mapping-filter; `AutoMapButton` and
  `SyncPanel` sit **outside** the `FilterBar` as separate flex siblings.
- **Invoices** (`app/finance/transactions/invoices/page.tsx`): fetches
  `/api/finance/ledger/invoices?year=&source=` — whole year loaded
  client-side via `useQuery`, no pagination. Mapping per
  `invoice_line_items`, rolled up via `invoiceMapped()`. FilterBar already
  holds every control on one line (search, year, source, status, type,
  mapping, show-voided, sync, auto-map) — **this is the target layout** for
  the other three tabs.
- **Expenses** (`app/finance/transactions/expenses/page.tsx`): fetches
  `/api/finance/expenses?from=&to=` — **already takes a date range**, whole
  range loaded client-side, no pagination. Mapping is 1:1 per row
  (`chart_of_accounts_id`). Has an existing per-row dismiss-flag precedent:
  `inventory_alert_dismissed` (boolean column, PATCH-toggled, optimistic
  local update) — this is the pattern acceptance follows. FilterBar holds
  search/year/mapping; `AutoMapButton`/`SyncPanel` sit outside.
- **Bank Ledger** (`app/finance/transactions/bank-ledger/page.tsx`): fetches
  `/api/finance/bank-ledger?from=&to=` — **already takes a date range**.
  Mapping is 1:1 per row but the tab's "Needs review" stat is keyed on
  `flow_type === "unclassified"`, not on `chart_of_accounts_id`. No
  `AutoMapButton`/`SyncPanel` here. FilterBar already single-line
  (search/year/flow).
- `lib/table/{types,applyControls,urlState}.ts` — generic URL-synced
  search/filter/sort engine (`useTableControls`). Filter values are
  comma-joined strings in the URL; a filter's `matches(row, selected)`
  predicate can treat a 2-element `selected` array as `[from, to]`. This is
  the existing mechanism, reused for the date-range filter.
- Only Orders and Invoices currently take a `year` param server-side;
  Expenses and Bank Ledger already take `from`/`to`. Switching Orders and
  Invoices' APIs from `year` to `from`/`to` is required so the new date
  filter behaves identically (and, for Orders, so pagination stays correct
  across the *filtered* set rather than only the loaded page).

---

## Decisions from brainstorming

- **Accept granularity — whole row.** One "Accept" action per
  order/invoice/expense/bank-ledger row dismisses the warning for that
  entire row, regardless of how many line items (for Orders/Invoices) remain
  individually unmapped. Matches the `inventory_alert_dismissed` precedent.
- **Control placement — inline next to the mapping pill.** An "Accept"
  link/button sits next to `MappingStatusPill` in the *collapsed* row,
  visible whenever the row isn't fully mapped. No need to expand the row.
  Toggleable (an accepted row can be un-accepted the same way).
- **Date filter fully replaces Year.** `YearSelect` is removed from all four
  pages. The new `DateRangeFilter` is the only date-scoping control,
  defaulting to Jan 1–Dec 31 of the current calendar year, adjustable to any
  range (including spans across a year boundary).
- **Bank Ledger accept dismisses "needs review."** Accepting a Bank Ledger
  row sets `unmapped_accepted` without touching `flow_type` or
  `chart_of_accounts_id`; the "Needs review" stat excludes accepted rows.

---

## Data model

One migration, additive only:

```sql
alter table public.square_orders  add column if not exists unmapped_accepted boolean not null default false;
alter table public.invoices       add column if not exists unmapped_accepted boolean not null default false;
alter table public.expenses       add column if not exists unmapped_accepted boolean not null default false;
alter table public.ramp_bank_ledger add column if not exists unmapped_accepted boolean not null default false;
```

Rejected alternative: a shared polymorphic `transaction_mapping_acceptances
(source_table, source_id, accepted_at)` table. Rejected because it needs an
extra lookup join per page load, has no real FK integrity across four
unrelated tables, and diverges from the `inventory_alert_dismissed`
convention already established in this exact area of the codebase. A column
per table is the smaller, more idiomatic change (CLAUDE.md: reuse/extend
existing tables over forking parallel structures).

---

## `lib/finance/mappingStatus.ts` changes

`mappingState` and `matchesMappingFilter` gain an `accepted` parameter.
Priority order (fully-mapped always wins over a stale accept flag; accept
only matters while still not-fully-mapped):

```ts
export type MappingState = "empty" | "mapped" | "partial" | "unmapped" | "accepted";

export function mappingState(mapped: number, total: number, accepted = false): MappingState {
  if (total === 0) return "empty";
  if (mapped >= total) return "mapped";
  if (accepted) return "accepted";
  if (mapped > 0) return "partial";
  return "unmapped";
}

export type MappingFilterValue = "all" | "mapped" | "partial" | "unmapped" | "accepted";

export function matchesMappingFilter(filter, mapped, total, accepted = false): boolean {
  if (filter === "all") return true;
  const state = mappingState(mapped, total, accepted);
  if (state === "empty") return filter === "unmapped";
  return state === filter;
}
```

This means: re-mapping a previously-accepted row correctly flips its
displayed state back to "mapped" (the stale `accepted` flag becomes inert,
not cleared — no need to clear it on mapping, since it's simply never
consulted once `mapped >= total`). An accepted row is fully excluded from
the `"unmapped"` filter bucket and from any unmapped-count stat; a new
`"accepted"` bucket is added to `MappingFilter` so accepted rows stay
auditable rather than disappearing.

`MappingStatusPill` renders a distinct "✓ accepted" indicator (styled like
the existing "✓ mapped" success state but visually distinguishable, e.g.
`text-info`) for the `"accepted"` state.

---

## New shared components

### `AcceptUnmappedButton`

`app/finance/transactions/components/AcceptUnmappedButton.tsx` — client
component, inline next to `MappingStatusPill`. Props:

```ts
{ accepted: boolean; onToggle: () => Promise<void> }
```

The component itself has no opinion on when it should appear — each page
decides that from its own "needs attention" condition (mapped state for
Orders/Invoices/Expenses; `flow_type === "unclassified"` for Bank Ledger)
and simply doesn't mount the button when the row is already resolved. Shows
"Accept" when
`!accepted`, "Accepted ✓ (undo)"-style toggle when `accepted`, with a small
inline saving indicator, following the same optimistic-update-then-PATCH
pattern already used by `handleDismissInventoryAlert` in
`expenses/page.tsx`.

### `DateRangeFilter`

`app/finance/transactions/components/DateRangeFilter.tsx` — client
component, two `<input type="date">` fields (from/to), replaces
`YearSelect`'s call sites. Props:

```ts
{ from: string; to: string; onChange: (from: string, to: string) => void }
```

A small pure helper, colocated in `lib/finance/dateRange.ts` (with a test
file), provides `defaultYearRange(year = currentYear)` returning
`{ from: "YYYY-01-01", to: "YYYY-12-31" }`, used to seed each page's initial
state before the user picks anything.

---

## Per-tab wiring

### Orders

- `app/api/finance/transactions/route.ts`: `GET` switches from `year` to
  `from`/`to` query params (falling back to the current-year default range
  when absent, via `defaultYearRange()`), applied as
  `.gte("transaction_date", from).lte("transaction_date", to)`. Adds
  `unmapped_accepted` to the `square_orders` select. Adds a `PATCH` handler
  (id + `unmapped_accepted`) mirroring the Expenses PATCH pattern.
- `orders/page.tsx`: replaces `year` state with `from`/`to` state (seeded via
  `defaultYearRange()`), threaded into `loadTransactions`'s fetch URL and
  reset to page 1 on change. Swaps `YearSelect` for `DateRangeFilter`.
  `SummaryStatBar`'s "Unmapped line items" count excludes line items
  belonging to accepted orders. `AcceptUnmappedButton` added next to each
  row's `MappingStatusPill`, PATCHing the new endpoint and optimistically
  updating local state. `AutoMapButton` and `SyncPanel` move inside
  `FilterBar` (one line, matching Invoices).

### Invoices

- `app/api/finance/ledger/invoices/route.ts`: `GET` gains `from`/`to`
  params (alongside existing `source`/`partner_id`), replacing `year`.
  Adds a `PATCH` handler (id + `unmapped_accepted`) — none exists yet at
  invoice-header grain (only `invoice-line-items` has one).
- `invoices/page.tsx`: swaps `YearSelect` for `DateRangeFilter` (feeds the
  `useQuery` params). `invoiceMapped()`/`INVOICE_CONTROLS` pass the row's
  `unmapped_accepted` into `matchesMappingFilter`. `AcceptUnmappedButton`
  added next to the row's `MappingStatusPill`. Filter bar is already
  single-line — no reorder needed beyond the Year→DateRange swap.

### Expenses

- `app/api/finance/expenses/route.ts`: `PATCH` body handling extended with
  an early-return branch for `unmapped_accepted`, mirroring the existing
  `inventory_alert_dismissed` branch exactly.
- `expenses/page.tsx`: swaps `YearSelect` for `DateRangeFilter` (already
  feeds `from`/`to` into the existing fetch — no API GET change needed).
  `EXPENSE_CONTROLS`' mapping filter passes `e.unmapped_accepted`.
  `AcceptUnmappedButton` added next to the row's `MappingStatusPill`.
  `AutoMapButton`/`SyncPanel` move inside `FilterBar`.

### Bank Ledger

- `app/api/finance/bank-ledger/route.ts`: `PATCH` extended to accept
  `unmapped_accepted` (same shape as the Expenses branch).
- `bank-ledger/page.tsx`: swaps `YearSelect` for `DateRangeFilter` (no GET
  change needed). `needsReview` count excludes rows where
  `unmapped_accepted`. `AcceptUnmappedButton` added next to the existing
  unclassified-row controls. Filter bar already single-line.

---

## Error handling

PATCH failures follow the existing silent-no-op convention already used
throughout this file group (e.g. `handleDismissInventoryAlert`: `if
(!res.ok) return;` — no error banner, the optimistic update simply doesn't
apply). No new error-handling pattern is introduced.

## Testing

- `lib/finance/mappingStatus.test.ts` (existing) extended for the new
  `"accepted"` state and its priority ordering against `"mapped"` /
  `"partial"` / `"unmapped"`.
- `lib/finance/dateRange.test.ts` (new) covering `defaultYearRange()`.
- No other new pure-logic modules are introduced; `AcceptUnmappedButton` and
  `DateRangeFilter` are presentational and follow the existing untested
  pattern of this component directory (`YearSelect`, `MappingFilter`, etc.
  have no dedicated tests either).

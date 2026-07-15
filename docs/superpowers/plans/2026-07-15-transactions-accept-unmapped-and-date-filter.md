# Transactions: Accept Unmapped + Date Range Filter + Filter Bar Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a DB-backed "accept unmapped" dismissal, replace Year with a start/end date filter, and collapse each Transactions subtab's controls onto one line, across Orders/Invoices/Expenses/Bank Ledger.

**Execution Budget:** Mode = subagent-driven-development (5 file-locality groups: Foundation, Orders, Invoices, Expenses, Bank Ledger — exceeds the 6-file inline-plan ceiling). Spawn cap = 5 groups + 2 = **7**. Token target: ~250k. Route every task to the lean `impl` agent type (Sonnet, per the model column below); final whole-branch review is a single Opus pass after all 5 tasks land.

**Architecture:** One additive migration adds `unmapped_accepted boolean` to `square_orders`/`invoices`/`expenses`/`ramp_bank_ledger`. A shared pure helper (`lib/finance/mappingStatus.ts`) and two new presentational components (`AcceptUnmappedButton`, `DateRangeFilter`) live in the existing `app/finance/transactions/components/` directory and are consumed identically by all four subtab pages. Orders and Invoices' GET routes switch from a `year` param to `from`/`to` (Expenses/Bank Ledger already take `from`/`to`); each of the four PATCH routes (three existing, one new) gains an `unmapped_accepted` branch.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase (admin client), Vitest.

**Full design spec:** `docs/superpowers/specs/2026-07-15-transactions-accept-unmapped-and-date-filter-design.md` — read it once before Task 1 if anything below is ambiguous; individual task briefs are otherwise self-contained.

## Global Constraints

- No raw `zinc/amber/red/green/blue/gray` color utilities — use token classes (`text-info`, `text-accent-emphasis`, `text-faint`, etc.) per `docs/UI_STANDARD.md`.
- No hand-rolled buttons/inputs — use `.btn-secondary`/`inp-sm` and existing primitives; do not introduce new base styles.
- Every modified `lib/finance/*.ts` module keeps or extends its co-located `*.test.ts`; `npm run verify` (lint + typecheck + tests) must pass before each task's commit.
- API routes use `requireRole` per existing per-route convention (viewer for GET, `[]`/authenticated for PATCH) — match each file's existing calls, don't change auth tiers.
- Accept granularity is **whole-row**, not per-line-item (see spec). Do not add per-line-item accept controls.

---

## Task 1: Foundation — migration, mappingStatus, shared components

**Model:** Sonnet (`impl` agent type)

**Files:**
- Create: `supabase/migrations/20260730_transactions_unmapped_accepted.sql`
- Modify: `lib/finance/mappingStatus.ts`
- Modify: `lib/finance/mappingStatus.test.ts`
- Create: `lib/finance/dateRange.ts`
- Create: `lib/finance/dateRange.test.ts`
- Modify: `app/finance/transactions/components/MappingFilter.tsx`
- Modify: `app/finance/transactions/components/MappingStatusPill.tsx`
- Create: `app/finance/transactions/components/AcceptUnmappedButton.tsx`
- Create: `app/finance/transactions/components/DateRangeFilter.tsx`

**Interfaces (produced — Tasks 2–5 depend on these exact names/types):**
```ts
// lib/finance/mappingStatus.ts
export type MappingState = "empty" | "mapped" | "partial" | "unmapped" | "accepted";
export function mappingState(mapped: number, total: number, accepted?: boolean): MappingState;
export type MappingFilterValue = "all" | "mapped" | "partial" | "unmapped" | "accepted";
export function matchesMappingFilter(filter: MappingFilterValue, mapped: number, total: number, accepted?: boolean): boolean;

// lib/finance/dateRange.ts
export interface YearRange { from: string; to: string } // "YYYY-01-01" / "YYYY-12-31"
export function defaultYearRange(year?: number): YearRange; // year defaults to new Date().getFullYear()

// app/finance/transactions/components/MappingStatusPill.tsx
export default function MappingStatusPill(props: { mapped: number; total: number; accepted?: boolean }): JSX.Element | null;

// app/finance/transactions/components/AcceptUnmappedButton.tsx
export default function AcceptUnmappedButton(props: { accepted: boolean; onToggle: () => Promise<void> }): JSX.Element;

// app/finance/transactions/components/DateRangeFilter.tsx
export default function DateRangeFilter(props: { from: string; to: string; onChange: (from: string, to: string) => void }): JSX.Element;
```

### Step 1: Migration

```sql
-- Manual "this doesn't need a real GL mapping" dismissal, one column per
-- Transactions-tab source table. Mirrors expenses.inventory_alert_dismissed.
alter table public.square_orders    add column if not exists unmapped_accepted boolean not null default false;
alter table public.invoices         add column if not exists unmapped_accepted boolean not null default false;
alter table public.expenses         add column if not exists unmapped_accepted boolean not null default false;
alter table public.ramp_bank_ledger add column if not exists unmapped_accepted boolean not null default false;
```
Do **not** apply this migration to prod — leave it for the human to apply (repo convention: subagents never run migrations against live Supabase).

### Step 2: `mappingState` / `matchesMappingFilter`

Priority: `total === 0` → `"empty"`; else `mapped >= total` → `"mapped"` (wins over a stale accept flag); else `accepted` → `"accepted"`; else `mapped > 0` → `"partial"`; else `"unmapped"`. `matchesMappingFilter` computes `mappingState(mapped, total, accepted)` and compares, with the existing `"empty"` → only matches `"unmapped"` special case unchanged.

**Test cases to add to `mappingStatus.test.ts`** (existing tests must still pass unmodified — `accepted` is optional and defaults to `false`):
- `mappingState(1, 3, true)` → `"accepted"` (partial + accepted)
- `mappingState(0, 3, true)` → `"accepted"` (fully unmapped + accepted)
- `mappingState(3, 3, true)` → `"mapped"` (fully mapped wins over accepted)
- `mappingState(0, 0, true)` → `"empty"` (no children — accepted is irrelevant)
- `matchesMappingFilter("accepted", 1, 3, true)` → `true`
- `matchesMappingFilter("unmapped", 1, 3, true)` → `false` (accepted rows must NOT show up in the "unmapped" bucket)
- `matchesMappingFilter("accepted", 3, 3, true)` → `false` (fully-mapped-but-stale-accepted-flag row is `"mapped"`, not `"accepted"`)

### Step 3: `lib/finance/dateRange.ts`

```ts
export interface YearRange { from: string; to: string }

export function defaultYearRange(year: number = new Date().getFullYear()): YearRange {
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}
```

**Test cases (`dateRange.test.ts`):**
- `defaultYearRange(2026)` → `{ from: "2026-01-01", to: "2026-12-31" }`
- `defaultYearRange()` with no arg returns an object whose `from`/`to` both start with the current 4-digit year (assert via `new Date().getFullYear()` in the test, not a hardcoded year)

### Step 4: `MappingFilter.tsx`

Add one `<option value="accepted">Accepted</option>` after the existing `<option value="unmapped">Unmapped</option>`. No prop-shape change — `MappingFilterValue` already covers `"accepted"` from Step 2.

### Step 5: `MappingStatusPill.tsx`

Add `accepted = false` to the destructured props (type: `{ mapped: number; total: number; accepted?: boolean }`), pass it into `mappingState(mapped, total, accepted)`, and add one branch before the final `"unmapped"` fallback:
```tsx
if (state === "accepted") return <span className="text-[10px] text-info">✓ accepted</span>;
```

### Step 6: `AcceptUnmappedButton.tsx`

New client component. Internal `saving` boolean state (following the `LineItemRow`/`ExpenseRowView` pattern already in this directory: `setSaving(true); await onToggle(); setSaving(false);`). Every caller of this component sits inside a table row whose `<tr>` has its own `onClick` (row-expand toggle), so `handleClick` must stop propagation before calling `onToggle`:
```tsx
async function handleClick(e: React.MouseEvent) {
  e.stopPropagation();
  setSaving(true);
  await onToggle();
  setSaving(false);
}
```
Renders a small text-button (not `.btn-secondary` — this sits inline next to a `text-[10px]` pill, so match that scale):
- Not accepted: `<button onClick={handleClick} className="text-[10px] text-accent-emphasis hover:underline disabled:opacity-50" disabled={saving}>Accept</button>`
- Accepted: `<button onClick={handleClick} className="text-[10px] text-info hover:underline disabled:opacity-50" disabled={saving}>✓ accepted (undo)</button>`

### Step 7: `DateRangeFilter.tsx`

Two native date inputs, each `className="inp-sm w-auto"`:
```tsx
<input type="date" value={from} max={to} onChange={(e) => onChange(e.target.value, to)} className="inp-sm w-auto" />
<input type="date" value={to} min={from} onChange={(e) => onChange(from, e.target.value)} className="inp-sm w-auto" />
```
Wrap both in a `<div className="flex items-center gap-1.5">` with a `<span className="text-faint text-xs">–</span>` separator between them (matches the terse label-free style of `YearSelect`).

**Acceptance criteria:**
- `npm run verify` passes (lint + typecheck + `mappingStatus.test.ts` + `dateRange.test.ts` all green).
- No component in this task imports from `orders/`, `invoices/`, `expenses/`, or `bank-ledger/` — foundation stays a leaf dependency.

### Step 8: Commit

```bash
git add supabase/migrations/20260730_transactions_unmapped_accepted.sql lib/finance/mappingStatus.ts lib/finance/mappingStatus.test.ts lib/finance/dateRange.ts lib/finance/dateRange.test.ts app/finance/transactions/components/MappingFilter.tsx app/finance/transactions/components/MappingStatusPill.tsx app/finance/transactions/components/AcceptUnmappedButton.tsx app/finance/transactions/components/DateRangeFilter.tsx
git commit -m "feat(finance): accept-unmapped + date-range foundation for Transactions tabs"
```

---

## Task 2: Orders

**Model:** Sonnet (`impl` agent type)
**Depends on:** Task 1 (`mappingState`, `MappingStatusPill`, `AcceptUnmappedButton`, `DateRangeFilter`, `defaultYearRange`)

**Files:**
- Modify: `app/api/finance/transactions/route.ts`
- Modify: `app/finance/transactions/orders/page.tsx`

**Interfaces:**
- Consumes: `defaultYearRange(): YearRange` from `lib/finance/dateRange`; `mappingState(mapped, total, accepted?): MappingState` from `lib/finance/mappingStatus`; `AcceptUnmappedButton({accepted, onToggle})` and `DateRangeFilter({from, to, onChange})` from `../components/*`.
- Produces: `PATCH /api/finance/transactions` accepting `{ id: string; unmapped_accepted: boolean }`, returning `{ id, unmapped_accepted }`.

### Step 1: `app/api/finance/transactions/route.ts` — GET switches `year` → `from`/`to`

Replace the current `year`/`startDate`/`endDate` block (currently `route.ts:16-22`, using `.gte(...).lt(...)` against `${year+1}-01-01`) with:
```ts
import { defaultYearRange } from "@/lib/finance/dateRange";
// ...
const { from: defYearFrom, to: defYearTo } = defaultYearRange();
const startDate = searchParams.get("from") ?? defYearFrom;
const endDate   = searchParams.get("to")   ?? defYearTo;
```
Change the query's date bounds from `.gte("transaction_date", startDate).lt("transaction_date", endDate)` to `.gte("transaction_date", startDate).lte("transaction_date", endDate)` (inclusive end date — `endDate` is now `"YYYY-12-31"`, not `"YYYY+1-01-01"`; matches the Expenses/Bank Ledger route convention). Add `unmapped_accepted` to the `square_orders` select list (alongside `notes,`). No other GET behavior changes — the enrichment/prefill logic is untouched and already spreads `...txn` through to the response, so `unmapped_accepted` passes through automatically.

### Step 2: `app/api/finance/transactions/route.ts` — add PATCH

```ts
export async function PATCH(req: NextRequest) {
  try { await requireRole([]); } catch (res) { return res as Response; }
  const body = await req.json() as { id: string; unmapped_accepted: boolean };
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("square_orders")
    .update({ unmapped_accepted: body.unmapped_accepted })
    .eq("id", body.id)
    .select("id, unmapped_accepted")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
```

### Step 3: `orders/page.tsx` — wire it up

- Replace the `import YearSelect from "../components/YearSelect";` line with `import DateRangeFilter from "../components/DateRangeFilter";`; add `import AcceptUnmappedButton from "../components/AcceptUnmappedButton";` and `import { defaultYearRange } from "@/lib/finance/dateRange";`. `mappingState` is already reachable via the existing `import { matchesMappingFilter, type MappingFilterValue } from "@/lib/finance/mappingStatus";` line — widen it to `import { mappingState, matchesMappingFilter, type MappingFilterValue } from "@/lib/finance/mappingStatus";`.
- `Transaction` interface: add `unmapped_accepted: boolean;`.
- `ORDER_CONTROLS.filters`' `mapping` entry currently reads:
  ```ts
  matches: (t, sel) => {
    const [m, n] = orderMapped(t);
    return matchesMappingFilter(sel[0] as MappingFilterValue, m, n);
  },
  ```
  Add the fourth arg: `return matchesMappingFilter(sel[0] as MappingFilterValue, m, n, t.unmapped_accepted);` — without this, the "Unmapped" filter bucket would still show accepted orders, defeating the point of the feature.
- Replace `const currentYear = new Date().getFullYear();` and `const [year, setYear] = useState(currentYear);` (`orders/page.tsx:265-266`) with `const [{ from, to }, setRange] = useState(() => defaultYearRange());` — `currentYear` is not referenced anywhere else in this file (verified: it only ever seeded the removed `year` state), so drop it entirely rather than leaving an unused variable.
- `loadTransactions(from, to, pg)` — change signature and fetch URL to `` `/api/finance/transactions?from=${from}&to=${to}&page=${pg}&pageSize=${pageSize}` ``; update the `useEffect` deps to `[from, to, page, loadTransactions]`.
- `handleYearChange` → replace with `function handleRangeChange(f: string, t: string) { setRange({ from: f, to: t }); setPage(1); }`.
- Replace `<YearSelect year={year} onChange={handleYearChange} />` with `<DateRangeFilter from={from} to={to} onChange={handleRangeChange} />`.
- `SyncPanel`'s `year: number` prop (`app/finance/transactions/components/SyncPanel.tsx:12`) is a separate, unrelated concept — it seeds its own month-picker's default sync target and is not part of this task's date-range filter. Update only the two lines that reference the removed `year` state:
  ```tsx
  <SyncPanel<SyncResult>
    year={new Date(to).getFullYear()}
    storageKey="tpb-pos-last-sync"
    label="from Square"
    showMonthPicker
    buildEndpoint={({ year, month }) => `/api/finance/transactions/sync?year=${year}&month=${month}`}
    onSynced={() => loadTransactions(from, to, 1)}
    renderResult={/* existing renderResult function body — do not change it */}
  />
  ```
  Only the `year` and `onSynced` lines change; `storageKey`, `label`, `showMonthPicker`, `buildEndpoint`'s body, and `renderResult`'s body are untouched. (`buildEndpoint`'s inner `year`/`month` come from `SyncPanel`'s own closure params, not the page's state.)
- Add `async function handleToggleAccept(id: string, accepted: boolean)`: PATCH `/api/finance/transactions` with `{ id, unmapped_accepted: accepted }`, then `setTransactions((txns) => txns.map((t) => t.id === id ? { ...t, unmapped_accepted: accepted } : t));` (same optimistic-update shape as `handleSaveLineItem`).
- `handleAutoMap` (`orders/page.tsx:303-307`) has two references to fix: the endpoint `` `/api/finance/transactions/auto-map?year=${year}` `` (line 304) hits a route outside this task's file list — leave its `year`-param contract alone, just change the call site to `` `/api/finance/transactions/auto-map?year=${new Date(to).getFullYear()}` ``; and its reload call `loadTransactions(year, page)` (line 306) must become `loadTransactions(from, to, page)` to match the new 3-arg signature.
- Empty-state copy `<p className="text-sm text-secondary">No orders for {year}.</p>` (`orders/page.tsx:387`) references the removed `year` state — change `{year}` to `{from} – {to}`.
- `unmappedTotal`: change to exclude accepted orders before flattening:
  ```ts
  const unmappedTotal = transactions
    .filter((t) => !t.unmapped_accepted)
    .flatMap((t) => t.pos_line_items)
    .filter((li) => !li.effective_chart_of_accounts_id).length;
  ```
- `OrderRow`: add `onToggleAccept: (id: string, accepted: boolean) => Promise<void>` to its props, thread it from the page's map call. In the row's `<MappingStatusPill mapped={mappedCount} total={lineItems.length} />` cell, pass `accepted={txn.unmapped_accepted}` and, in that same `<td>`, render `AcceptUnmappedButton` beneath the pill whenever `mappingState(mappedCount, lineItems.length, txn.unmapped_accepted) !== "mapped"`:
  ```tsx
  <td className="px-4 py-2">
    <div className="flex flex-col gap-0.5 items-start">
      <MappingStatusPill mapped={mappedCount} total={lineItems.length} accepted={txn.unmapped_accepted} />
      {mappingState(mappedCount, lineItems.length, txn.unmapped_accepted) !== "mapped" && (
        <AcceptUnmappedButton accepted={txn.unmapped_accepted} onToggle={() => onToggleAccept(txn.id, !txn.unmapped_accepted)} />
      )}
    </div>
  </td>
  ```
  (`AcceptUnmappedButton` already calls `e.stopPropagation()` internally per Task 1, so clicking it won't also toggle the row's expand/collapse.)
- `<AutoMapButton key={year} onRun={handleAutoMap} />` (`orders/page.tsx:352`) is keyed on the removed `year` state (the key forces the button to reset its "N mapped" result readout when the scope changes) — change to `<AutoMapButton key={`${from}_${to}`} onRun={handleAutoMap} />`.
- Filter bar: move `<AutoMapButton .../>` and `<SyncPanel .../>` to be children of `<FilterBar>` (inside, after `<MappingFilter .../>`) instead of siblings after `</FilterBar>` closes, so the whole row (search, date range, mapping filter, auto-map, sync) sits on one flex line matching Invoices.

**Acceptance criteria:**
- `npm run verify` passes.
- Loading the Orders tab with no query params shows the current year's orders (server-side date-filtered, not client-filtered).
- Changing the date range refetches from the server and resets to page 1.
- Accepting an order whose line items are unmapped removes those line items from "Unmapped line items" in `SummaryStatBar` without changing their actual GL mapping.
- All Orders-tab controls (search, date range, mapping filter, auto-map, sync) render on one visual line at desktop width, matching the Invoices tab.

### Step 4: Commit

```bash
git add app/api/finance/transactions/route.ts app/finance/transactions/orders/page.tsx
git commit -m "feat(finance): accept-unmapped + date range on Orders transactions tab"
```

---

## Task 3: Invoices

**Model:** Sonnet (`impl` agent type)
**Depends on:** Task 1

**Files:**
- Modify: `app/api/finance/ledger/invoices/route.ts`
- Modify: `app/finance/transactions/invoices/page.tsx`
- Modify: `lib/query-keys.ts:87`

**Interfaces:**
- Consumes: same Task 1 exports as Task 2.
- Produces: `PATCH /api/finance/ledger/invoices` accepting `{ id: string; unmapped_accepted: boolean }`, returning `{ id, unmapped_accepted }`.

### Step 1: `app/api/finance/ledger/invoices/route.ts` — GET gains `from`/`to`

In the existing `GET` handler, alongside the existing `if (params.get("year"))` block, add (keep `year` working too — Task 3's page will stop sending it, but don't remove support since nothing else in the repo is being audited for other `year`-param callers of this route in this task):
```ts
if (params.get("from")) query = query.gte("invoice_date", params.get("from")!);
if (params.get("to"))   query = query.lte("invoice_date", params.get("to")!);
```
Add `unmapped_accepted` to the `invoices` select — the handler currently selects `*` from `invoices` (`select("*, contract_brewing_partners(...), invoice_line_items!...(...), invoice_batch_links(count)")`), so the new column is already included automatically; no select-list edit needed here.

### Step 2: `app/api/finance/ledger/invoices/route.ts` — add PATCH

```ts
export async function PATCH(req: NextRequest) {
  try { await requireRole([]); } catch (res) { return res as Response; }
  const body = await req.json() as { id: string; unmapped_accepted: boolean };
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("invoices")
    .update({ unmapped_accepted: body.unmapped_accepted })
    .eq("id", body.id)
    .select("id, unmapped_accepted")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
```

### Step 3: `invoices/page.tsx` — wire it up

- Replace the `import YearSelect from "../components/YearSelect";` line with `import DateRangeFilter from "../components/DateRangeFilter";`; add `import AcceptUnmappedButton from "../components/AcceptUnmappedButton";` and `import { defaultYearRange } from "@/lib/finance/dateRange";`. Widen `import { matchesMappingFilter, type MappingFilterValue } from "@/lib/finance/mappingStatus";` to `import { mappingState, matchesMappingFilter, type MappingFilterValue } from "@/lib/finance/mappingStatus";`.
- `InvoiceRow` interface (`extends Omit<Invoice, "invoice_line_items">`): add `unmapped_accepted: boolean;`.
- Replace `const currentYear = new Date().getFullYear();` and `const [year, setYear] = useState(currentYear);` (`invoices/page.tsx:483-484`) with `const [{ from, to }, setRange] = useState(() => defaultYearRange());` — `currentYear` has no other reference in this file, drop it entirely.
- `params` construction: replace `new URLSearchParams({ year: String(year) })` with `new URLSearchParams({ from, to })` (keep the existing `if (source !== "all") params.set("source", source);` line as-is).
- `lib/query-keys.ts:87` currently reads `ledgerInvoices: (year: number, source: string) => ["finance", "ledger", "invoices", year, source] as const,`. This is the only call site in the repo (verified via repo-wide grep). Change the param from `year: number` to `range: string`, keeping the tuple shape: `ledgerInvoices: (range: string, source: string) => ["finance", "ledger", "invoices", range, source] as const,`. Update its doc comment from "Invoice list filtered by year + source." to "Invoice list filtered by date range + source."
- Update the call site: `queryKeys.finance.ledgerInvoices(year, source)` → `queryKeys.finance.ledgerInvoices(`${from}_${to}`, source)`.
- Replace `<YearSelect year={year} onChange={setYear} />` with `<DateRangeFilter from={from} to={to} onChange={(f, t) => setRange({ from: f, to: t })} />`.
- `invoiceMapped()` stays as-is (returns `[mapped, total]`); update `INVOICE_CONTROLS.filters` mapping entry's `matches` to pass `inv.unmapped_accepted`:
  ```ts
  matches: (i, sel) => {
    const [m, n] = invoiceMapped(i);
    return matchesMappingFilter(sel[0] as MappingFilterValue, m, n, i.unmapped_accepted);
  },
  ```
- `handleAutoMap`'s `?year=${year}` query param on `/api/finance/ledger/invoices/auto-map` — leave this endpoint's contract alone (out of scope for this task); change it to `?year=${new Date(to).getFullYear()}` so it still passes a valid year derived from the current range's end date, since that auto-map route is not part of this plan's file list and its `year` param contract isn't being changed.
- `SyncPanel`'s `year` prop (`<SyncPanel<InvoiceSyncResult> year={year} storageKey="tpb-invoices-last-sync" label="from Square" buildEndpoint={({ year }) => `/api/finance/ledger/sync-square?year=${year}`} onSynced={() => refetch()} renderResult={...} />`) also references the removed `year` state — change only that one prop to `year={new Date(to).getFullYear()}`. `buildEndpoint`'s inner `year` comes from `SyncPanel`'s own closure param, not the page's state, so its body is unchanged; `onSynced={() => refetch()}` is already state-independent and unchanged.
- In `InvoiceExpandableRow`, add an `onToggleAccept: (id: string, accepted: boolean) => Promise<void>` prop, threaded from the page. The Mapping `<td>` currently reads:
  ```tsx
  <td className="px-4 py-2">
    <div className="flex flex-col gap-1">
      {lineItems.length === 0
        ? <span className="text-disabled">—</span>
        : <MappingStatusPill mapped={mappedCount} total={lineItems.length} />}
      {missingDelivery && (
        <span className="text-[10px] text-accent">⚠ deposit missing delivery</span>
      )}
    </div>
  </td>
  ```
  Pass `accepted={inv.unmapped_accepted}` to the pill, and add `AcceptUnmappedButton` right after the ternary (still inside the `flex flex-col` div, before `missingDelivery`), gated on `lineItems.length > 0 && mappingState(mappedCount, lineItems.length, inv.unmapped_accepted) !== "mapped"` — the `lineItems.length > 0` guard matches the existing empty-state ternary so a line-item-less invoice (which never renders a pill) doesn't get an accept button either.
- Page-level `handleToggleAccept(id, accepted)`: PATCH `/api/finance/ledger/invoices` with `{ id, unmapped_accepted: accepted }`, then call `refetch()` (matches this page's existing `handleSaveLineItem` pattern — it already calls `refetch()` rather than doing local optimistic state, since `raw`/`hookRows`/`invoices` are all derived from the `useQuery` cache).
- `<AutoMapButton key={year} onRun={handleAutoMap} />` (`invoices/page.tsx:612`) is keyed on the removed `year` state — change to `<AutoMapButton key={`${from}_${to}`} onRun={handleAutoMap} />`.
- Filter bar: already single-line; no reorder needed beyond the `YearSelect` → `DateRangeFilter` swap already covered above.

**Acceptance criteria:**
- `npm run verify` passes.
- Invoices tab loads the current year's invoices by default (`from`/`to` query params, not `year`).
- Selecting "Accepted" in the Mapping filter shows only invoices with `unmapped_accepted: true` and `mappingState !== "mapped"`.
- Accepting a partially-mapped invoice removes it from the "Unmapped" filter bucket.

### Step 4: Commit

```bash
git add app/api/finance/ledger/invoices/route.ts app/finance/transactions/invoices/page.tsx
git commit -m "feat(finance): accept-unmapped + date range on Invoices transactions tab"
```

---

## Task 4: Expenses

**Model:** Sonnet (`impl` agent type)
**Depends on:** Task 1

**Files:**
- Modify: `app/api/finance/expenses/route.ts`
- Modify: `app/finance/transactions/expenses/page.tsx`

**Interfaces:**
- Consumes: same Task 1 exports as Task 2.
- Produces: `PATCH /api/finance/expenses` body gains an optional `unmapped_accepted: boolean` field; response echoes `{ id, unmapped_accepted }` on that branch (same shape as the existing `inventory_alert_dismissed` branch).

### Step 1: `app/api/finance/expenses/route.ts` — PATCH branch

The route's `GET` already accepts `from`/`to` — no GET change needed. In `PATCH`, extend the body type and add a branch mirroring the existing `inventory_alert_dismissed` early-return (which sits right after the `if (!body.id)` check):
```ts
const body = await req.json() as {
  id: string;
  chart_of_accounts_id?: string | null;
  inventory_alert_dismissed?: boolean;
  unmapped_accepted?: boolean;
};
// ...
if (typeof body.unmapped_accepted === "boolean") {
  const { data, error } = await supabase
    .from("expenses")
    .update({ unmapped_accepted: body.unmapped_accepted })
    .eq("id", body.id)
    .select("id, unmapped_accepted")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
```
Place this branch immediately after the existing `inventory_alert_dismissed` branch, before the `let coaId` GL-mapping logic.

### Step 2: `expenses/page.tsx` — wire it up

- Replace the `import YearSelect from "../components/YearSelect";` line with `import DateRangeFilter from "../components/DateRangeFilter";`; add `import AcceptUnmappedButton from "../components/AcceptUnmappedButton";` and `import { defaultYearRange } from "@/lib/finance/dateRange";`. Widen `import { matchesMappingFilter, type MappingFilterValue } from "@/lib/finance/mappingStatus";` to `import { mappingState, matchesMappingFilter, type MappingFilterValue } from "@/lib/finance/mappingStatus";`.
- `ExpenseRow` interface: add `unmapped_accepted: boolean;`.
- Replace `const currentYear = new Date().getFullYear();` and `const [year, setYear] = useState(currentYear);` (`expenses/page.tsx:195,197`) with `const [{ from, to }, setRange] = useState(() => defaultYearRange());` — `currentYear` has no other reference in this file, drop it entirely.
- `loadAll(y: number)` → change signature to `loadAll(from: string, to: string)`; its body already builds `` `${y}-01-01` ``/`` `${y}-12-31` `` for the fetch — replace those two lines with using `from`/`to` directly. Update the `useEffect` to `useEffect(() => { loadAll(from, to); }, [loadAll, from, to]);`.
- `handleAutoMap` (`expenses/page.tsx:256-260`) has two references to fix: the endpoint `` `/api/finance/expenses/auto-map?from=${year}-01-01&to=${year}-12-31` `` → `` `/api/finance/expenses/auto-map?from=${from}&to=${to}` ``; and its reload call `loadAll(year)` (line 259) → `loadAll(from, to)` to match the new 2-arg signature.
- Replace `<YearSelect year={year} onChange={setYear} />` with `<DateRangeFilter from={from} to={to} onChange={(f, t) => setRange({ from: f, to: t })} />`.
- `SyncPanel`'s props also reference the removed `year` state and the removed `loadAll(year)` signature:
  ```tsx
  <SyncPanel<SyncResult>
    year={new Date(to).getFullYear()}
    storageKey="tpb-expenses-last-sync"
    label="Ramp"
    buildEndpoint={() => `/api/finance/expenses/sync?from=${from}&to=${to}`}
    onSynced={() => loadAll(from, to)}
    renderResult={/* existing renderResult function body — do not change it */}
  />
  ```
  Unlike Orders/Invoices, this page has no month picker (`showMonthPicker` is not passed), so `buildEndpoint` no longer needs the `{year}` it used to destructure — it now closes over the page's own `from`/`to` state directly, so the sync always targets exactly the currently-selected range instead of always a whole calendar year.
- `EXPENSE_CONTROLS.filters` mapping entry: change `matchesMappingFilter(sel[0] as MappingFilterValue, e.chart_of_accounts_id ? 1 : 0, 1)` to add the fourth arg: `matchesMappingFilter(sel[0] as MappingFilterValue, e.chart_of_accounts_id ? 1 : 0, 1, e.unmapped_accepted)`.
- `mappedCount` (used in the `SummaryStatBar` "Mapped" stat): change from `expenses.filter((e) => e.chart_of_accounts_id).length` to `expenses.filter((e) => e.chart_of_accounts_id || e.unmapped_accepted).length` so accepted rows count as resolved in that stat.
- Empty-state copy `<p className="text-sm text-secondary">No expenses for {year}.</p>` (`expenses/page.tsx:325`) references the removed `year` state — change `{year}` to `{from} – {to}`.
- `async function handleToggleAccept(id: string, accepted: boolean)`: PATCH `/api/finance/expenses` with `{ id, unmapped_accepted: accepted }`, then `setExpenses((es) => es.map((e) => e.id === id ? { ...e, unmapped_accepted: accepted } : e));` (same shape as the existing `handleDismissInventoryAlert`).
- In `ExpenseRowView`, add `onToggleAccept: (id: string, accepted: boolean) => Promise<void>` to props, thread from the page. In the row's Mapping `<td>` (`<MappingStatusPill mapped={mapped} total={1} />`), pass `accepted={e.unmapped_accepted}` to the pill and render `AcceptUnmappedButton` beneath it, same `mappingState(...) !== "mapped"` gating as prior tasks, using `mapped`/`1`/`e.unmapped_accepted`.
- `<AutoMapButton key={year} onRun={handleAutoMap} />` (`expenses/page.tsx:279`) is keyed on the removed `year` state — change to `<AutoMapButton key={`${from}_${to}`} onRun={handleAutoMap} />`.
- Filter bar: move `<AutoMapButton .../>` and `<SyncPanel .../>` inside `<FilterBar>` (after `<MappingFilter .../>`), same relocation as Task 2's Orders tab.

**Acceptance criteria:**
- `npm run verify` passes.
- Expenses tab loads the current year's expenses via `from`/`to`, matching the already-existing API contract (no route GET change was needed).
- Accepting an unmapped expense moves its `mappedCount` into the "Mapped" stat and out of the `"unmapped"` filter bucket, without setting a `chart_of_accounts_id`.
- All Expenses-tab controls sit on one line, matching Invoices.

### Step 3: Commit

```bash
git add app/api/finance/expenses/route.ts app/finance/transactions/expenses/page.tsx
git commit -m "feat(finance): accept-unmapped + date range on Expenses transactions tab"
```

---

## Task 5: Bank Ledger

**Model:** Sonnet (`impl` agent type)
**Depends on:** Task 1

**Files:**
- Modify: `app/api/finance/bank-ledger/route.ts`
- Modify: `app/finance/transactions/bank-ledger/page.tsx`

**Interfaces:**
- Consumes: `defaultYearRange`, `DateRangeFilter`, `AcceptUnmappedButton` from Task 1. (Bank Ledger does not use `mappingState`/`MappingStatusPill` — its warning axis is `flow_type`, not GL mapping; see spec's "Bank ledger accept" decision.)
- Produces: `PATCH /api/finance/bank-ledger` body gains an optional `unmapped_accepted: boolean` field.

### Step 1: `app/api/finance/bank-ledger/route.ts` — PATCH branch

GET already accepts `from`/`to` — no change needed. Extend the `PATCH` body type and patch-building logic:
```ts
const body = await req.json() as { id: string; flow_type?: string; chart_of_accounts_id?: string | null; unmapped_accepted?: boolean };
// ... existing patch object building for flow_type / chart_of_accounts_id stays as-is ...
if (typeof body.unmapped_accepted === "boolean") {
  patch.unmapped_accepted = body.unmapped_accepted;
}
```
Add this alongside the existing `if (body.flow_type)` / `if ("chart_of_accounts_id" in body)` blocks (all three merge into the same `patch` object, single `update(patch)` call already in the handler). Add `unmapped_accepted` to the final `.select("id, flow_type, affects_pl, chart_of_accounts_id, mapping_source")` call so the response includes it: `.select("id, flow_type, affects_pl, chart_of_accounts_id, mapping_source, unmapped_accepted")`.

### Step 2: `bank-ledger/page.tsx` — wire it up

- Replace the `import YearSelect from "../components/YearSelect";` line with `import DateRangeFilter from "../components/DateRangeFilter";`; add `import AcceptUnmappedButton from "../components/AcceptUnmappedButton";` and `import { defaultYearRange } from "@/lib/finance/dateRange";`. This page does not need `mappingState`/`matchesMappingFilter` — it has no `MappingFilter`/`MappingStatusPill` usage today and this task doesn't add any (see Interfaces note above).
- `BankRow` interface: add `unmapped_accepted: boolean;`.
- Replace `const currentYear = new Date().getFullYear();` and `const [year, setYear] = useState(currentYear);` (`bank-ledger/page.tsx:61-62`) with `const [{ from, to }, setRange] = useState(() => defaultYearRange());` — `currentYear` has no other reference in this file, drop it entirely.
- `loadAll(y: number)` → change to `loadAll(from: string, to: string)`, replacing the `` `${y}-01-01` ``/`` `${y}-12-31` `` fetch URL construction with the passed-in `from`/`to` directly. Update the `useEffect` to `useEffect(() => { loadAll(from, to); }, [loadAll, from, to]);`.
- Replace `<YearSelect year={year} onChange={setYear} />` with `<DateRangeFilter from={from} to={to} onChange={(f, t) => setRange({ from: f, to: t })} />`.
- `needsReview`: change from `rows.filter((r) => r.flow_type === "unclassified").length` to `rows.filter((r) => r.flow_type === "unclassified" && !r.unmapped_accepted).length`.
- Empty-state copy `` <p ...>No bank-account activity for {year}. Click &ldquo;Sync Ramp&rdquo; on the Expenses tab to import.</p> `` (`bank-ledger/page.tsx:120`) references the removed `year` state — change `{year}` to `` {from} – {to} ``.
- `patchRow` already does optimistic local state update by spreading the PATCH response (`upd`) — extend its return-state merge to include `unmapped_accepted: upd.unmapped_accepted ?? r.unmapped_accepted`.
- Add `async function handleToggleAccept(id: string, accepted: boolean) { await patchRow(id, { unmapped_accepted: accepted }); }` — reuse the existing `patchRow` plumbing rather than writing a second fetch call. (This requires widening `patchRow`'s `patch` parameter type from `{ flow_type?: FlowType; chart_of_accounts_id?: string | null }` to add `unmapped_accepted?: boolean`, and passing it straight through in the `JSON.stringify({ id, ...patch })` call already present.)
- In the row's `flow_type === "unclassified"` branch (the `<div className="flex flex-col gap-1 min-w-[180px]">` block containing the `<select>` and `<AccountSelect>`), add `<AcceptUnmappedButton accepted={r.unmapped_accepted} onToggle={() => handleToggleAccept(r.id, !r.unmapped_accepted)} />` beneath the existing `AccountSelect`. Rows where `flow_type !== "unclassified"` render the `Badge` branch as before and don't need the button (nothing to accept — they're already resolved).
- Filter bar: already single-line (search, date range, flow filter) — no reorder needed beyond the `YearSelect` → `DateRangeFilter` swap.

**Acceptance criteria:**
- `npm run verify` passes.
- Bank Ledger tab loads the current year's rows via `from`/`to` (API contract unchanged, page-only change).
- Accepting an unclassified row removes it from the "Needs review" stat without changing its `flow_type`.
- Rows that are already classified (not `"unclassified"`) show no accept control.

### Step 3: Commit

```bash
git add app/api/finance/bank-ledger/route.ts app/finance/transactions/bank-ledger/page.tsx
git commit -m "feat(finance): accept-unmapped + date range on Bank Ledger transactions tab"
```

---

## Final Verification (after all 5 tasks)

- [ ] Run `npm run verify` at repo root — lint + typecheck + full test suite green.
- [ ] Start the dev server, open each of the four Transactions subtabs, and confirm: one-line filter bar, date range defaults to current year, accepting a row removes it from its tab's unmapped/needs-review stat, and un-accepting restores it.
- [ ] Single whole-branch Opus review pass (per CLAUDE.md review economy) before opening a PR.

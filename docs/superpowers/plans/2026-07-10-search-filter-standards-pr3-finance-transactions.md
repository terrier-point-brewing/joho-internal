# Search / Filter / Sort Standards — PR 3 (Finance Transactions) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Migrate the four finance **transactions** tables (orders, invoices, expenses, bank-ledger) off the finance-local `LedgerTable.useTableSort`/`SortableTh` onto the shared `useTableControls` + `app/components/ui/SortableTh` + `FilterBar`, add field-coded search, then retire the now-unused local sort primitive. Scope is transactions-only per decision; model/sales/statements and payroll/settings are untouched.

**Architecture:** Each page replaces its local `useTableSort` + inline `.filter().sort()` chain with `useTableControls`, driving the existing `YearSelect`/`MappingFilter` and inline selects through the hook (or keeping server-side params local). `MappingFilter` and `showVoided` become `matches` predicates; `status`/`type` become equality filters; `source` (invoices) stays a server-side fetch param. The shared `app/components/ui/SortableTh` replaces the local one; after all four migrate, the local `useTableSort`/`SortableTh` are deleted from `LedgerTable.tsx`.

**Tech Stack:** Next.js 16 App Router, TypeScript, Tailwind v4, React 19, Vitest (node, `lib/**` only), `next/navigation`.

## Global Constraints

- Foundation on `main`: `lib/table/{types,applyControls,urlState}.ts`; `app/components/ui/{useTableControls.ts,SearchInput,FilterChips,FilterSelect,FilterBar,SortableTh}.tsx`. `FilterSpec` supports `matches?: (row, selected[]) => boolean`; `coerce()` sorts ISO date strings chronologically (date accessors return the raw ISO string).
- **No `prefix` needed:** each finance page owns its whole URL (sibling nav routes, not tabs sharing one URL). Confirmed in the finance audit.
- **`year` and `source` are DATA-FETCH params, not client filters.** `YearSelect` (year) drives the API query + queryKey; invoices `source` drives the query + queryKey. Keep them as local state driving the fetch — do NOT route them through `applyControls`. Place their controls inside the shared `FilterBar` for layout only.
- **`MappingFilter` stays as the UI component** but is driven by hook state: its value = `filters.mapping?.[0] ?? "all"`, its onChange sets `setFilter("mapping", v === "all" ? [] : [v])`. The mapping dimension is a `matches` predicate using the existing `matchesMappingFilter(value, mapped, total)` from `lib/finance/mappingStatus.ts`.
- **Category colors** are the sanctioned raw-color exception — when a colored dimension (invoice status/type/source, order status, expense state, bank flow_type) becomes a `FilterSelect`/`FilterChips`, pass its color via `options[].className` from `app/finance/lib/categoryColors.ts`. Never token-swap.
- **Behavior-preserving:** same rows for the same intent. **Summary stats:** invoices' `totalValue`/`openValue`/`unlinkedCount` currently derive from the FILTERED set → keep deriving from the hook's final visible rows; orders' `unmappedTotal` and expenses' stats currently derive from the UNFILTERED set → keep them unfiltered (do not silently change). Note this per task.
- **Accepted minor:** the local `useTableSort` was **desc-first** (first click on a new column sorts descending); the shared `toggleSort` is **asc-first**. Set each table's `config.sort.default` to its current initial (date-desc) so the initial view is unchanged; first-click direction on other columns may differ — acceptable.
- **Suspense:** these pages newly call `useSearchParams` (via `useTableControls`). If `npm run build` errors "useSearchParams() should be wrapped in a suspense boundary", wrap the page's default export in `<Suspense>` (no fallback) or add a `loading.tsx` at the route. Verify build per task.
- **No component unit tests** (vitest is node/`lib`-only). Per-task gate = `tsc --noEmit` + `build` + `lint` + `test` (engine green) + `check:search-filter` (no new violations; finance had zero). Browser verification is a controller step at the end.
- **Commit trailer:** end every commit body with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## File Structure

Modified:
- `app/finance/transactions/orders/page.tsx` (Task 1)
- `app/finance/transactions/invoices/page.tsx` (Task 2)
- `app/finance/transactions/expenses/page.tsx` (Task 3)
- `app/finance/transactions/bank-ledger/page.tsx` (Task 4)
- `app/finance/transactions/components/LedgerTable.tsx` (Task 5 — remove local `useTableSort`/`SortableTh`)

**Shared pattern (all of Tasks 1–4):** replace `import { LedgerTable, SortableTh, useTableSort, Th, ... } from "../components/LedgerTable"` — keep importing `LedgerTable`/`Th`/`CategoryBadge(s)` from LedgerTable, but import `SortableTh` from `@/app/components/ui/SortableTh` and drop `useTableSort`. Use `useTableControls` for sort+filters.

---

### Task 1: Orders

**Files:** Modify `app/finance/transactions/orders/page.tsx`

**Context:** Real `<table>`. `year` (YearSelect, fetch param), `mappingFilter` (MappingFilter, predicate), `sort = useTableSort<SortKey>("date")` with `SortKey = date|order|customer|status|total`. `unmappedTotal`/`SummaryStatBar` derive from UNFILTERED `transactions` — keep that. Add field-coded search over the order's identity (`square_order_id` + `customer_name`).

- [ ] **Step 1: Imports + config (module scope)**

```tsx
import SortableTh from "@/app/components/ui/SortableTh";
import SearchInput from "@/app/components/ui/SearchInput";
import FilterBar from "@/app/components/ui/FilterBar";
import { useTableControls } from "@/app/components/ui/useTableControls";
import { matchesMappingFilter } from "@/lib/finance/mappingStatus";
import type { ControlsConfig } from "@/lib/table/types";
// keep: import { LedgerTable, Th, CategoryBadges } from "../components/LedgerTable"  (drop SortableTh/useTableSort from that import)

function orderMapped(txn: Transaction): [number, number] {
  const items = txn.pos_line_items ?? [];
  return [items.filter((li) => li.effective_chart_of_accounts_id).length, items.length];
}

const ORDER_CONTROLS: ControlsConfig<Transaction> = {
  search: [{ param: "q", accessor: (t) => [t.square_order_id, t.customer_name] }],
  filters: [
    { param: "mapping", matches: (t, sel) => { const [m, n] = orderMapped(t); return matchesMappingFilter(sel[0] as MappingFilterValue, m, n); } },
  ],
  sort: {
    columns: [
      { key: "date", accessor: (t) => t.transaction_date },
      { key: "order", accessor: (t) => t.square_order_id },
      { key: "customer", accessor: (t) => t.customer_name ?? "" },
      { key: "status", accessor: (t) => t.status ?? "" },
      { key: "total", accessor: (t) => t.total_cents },
    ],
    default: { key: "date", dir: "desc" },
  },
};
```

- [ ] **Step 2: Replace `mappingFilter` + `sort` state and `visibleTransactions`**

Remove `const [mappingFilter, setMappingFilter] = useState(...)` and `const sort = useTableSort(...)` and the `visibleTransactions` chain. Keep `year`/`setYear` (fetch param). Add:

```tsx
  const { rows: visibleTransactions, search, filters, sort, setSearch, setFilter, toggleSort, reset, activeCount } =
    useTableControls(transactions, ORDER_CONTROLS);
```

Keep `unmappedTotal` and `SummaryStatBar` reading the unfiltered `transactions` (unchanged).

- [ ] **Step 3: Replace the control row with FilterBar**

Replace the `<YearSelect/> <MappingFilter/>` control row with:

```tsx
      <FilterBar activeCount={activeCount} onClear={reset}>
        <SearchInput value={search.q ?? ""} onChange={(v) => setSearch("q", v)} placeholder="Search orders…" />
        <YearSelect year={year} onChange={handleYearChange} />
        <MappingFilter value={(filters.mapping?.[0] as MappingFilterValue) ?? "all"}
          onChange={(v) => setFilter("mapping", v === "all" ? [] : [v])} />
      </FilterBar>
```

(Keep `<AutoMapButton>`/`<SyncPanel>` where they are.)

- [ ] **Step 4: Swap the sort headers**

In the `<thead>`, replace each local `<SortableTh sortKey="X" sort={sort} .../>` with the shared `<SortableTh sortKey="X" label="…" sort={sort} onSort={toggleSort} align={…} />` for date/order/customer/status/total. Keep the plain `<Th>`s (Categories, Mapping).

- [ ] **Step 5: Gate + commit**

`npx tsc --noEmit && npm run build && npm run lint && npm run test`; `npm run check:search-filter` (no new violations). Commit `refactor(finance): Orders ledger onto shared search/filter/sort primitives`.

---

### Task 2: Invoices (heaviest)

**Files:** Modify `app/finance/transactions/invoices/page.tsx`

**Context:** Real `<table>`. Controls: `year` (fetch param + queryKey), `source` (SERVER-side fetch param + queryKey — "all"|"square"|"quickbooks"), `status` (equality), `typeFilter` (equality on `invoice_type`), `mappingFilter` (predicate), `showVoided` (toggle entangled with status), `sort = useTableSort<SortKey>("invoice_date")` with 7 keys. Summary stats (`totalValue`/`openValue`/`unlinkedCount`) derive from the FILTERED set → keep from final visible rows. Category colors: `INVOICE_STATUS_CLS`/`INVOICE_TYPE_CLS`/`INVOICE_SOURCE_CLS`.

- [ ] **Step 1: Imports + config (module scope)**

```tsx
import SortableTh from "@/app/components/ui/SortableTh";
import SearchInput from "@/app/components/ui/SearchInput";
import FilterSelect from "@/app/components/ui/FilterSelect";
import FilterBar from "@/app/components/ui/FilterBar";
import { useTableControls } from "@/app/components/ui/useTableControls";
import { matchesMappingFilter } from "@/lib/finance/mappingStatus";
import type { ControlsConfig } from "@/lib/table/types";

function invoiceMapped(inv: InvoiceRow): [number, number] {
  const items = inv.invoice_line_items ?? [];
  return [items.filter((li) => li.chart_of_accounts_id || li.bs_chart_of_accounts_id).length, items.length];
}

const INVOICE_CONTROLS: ControlsConfig<InvoiceRow> = {
  search: [{ param: "q", accessor: (i) => [i.invoice_number, i.customer_name] }],
  filters: [
    { param: "status", accessor: (i) => i.status ?? "" },
    { param: "type", accessor: (i) => i.invoice_type },
    { param: "mapping", matches: (i, sel) => { const [m, n] = invoiceMapped(i); return matchesMappingFilter(sel[0] as MappingFilterValue, m, n); } },
  ],
  sort: {
    columns: [
      { key: "invoice_number", accessor: (i) => i.invoice_number ?? "" },
      { key: "invoice_date", accessor: (i) => i.invoice_date ?? "" },
      { key: "customer_name", accessor: (i) => i.customer_name ?? "" },
      { key: "source", accessor: (i) => i.source ?? "" },
      { key: "type", accessor: (i) => i.invoice_type },
      { key: "total_cents", accessor: (i) => i.total_cents },
      { key: "status", accessor: (i) => i.status ?? "" },
    ],
    default: { key: "invoice_date", dir: "desc" },
  },
};
```

(Confirm the exact field names on `InvoiceRow` — `invoice_number`, `customer_name`, `source`, `invoice_type`, `total_cents`, `status`, `invoice_date` — against the file; adapt if any differ.)

- [ ] **Step 2: Wire hook; keep `year`/`source` local (fetch); keep `showVoided` local**

Remove `status`/`typeFilter`/`mappingFilter`/`sort` state and the `.filter().filter().filter().filter().sort()` chain. KEEP `year`/`setYear` and `source`/`setSource` (they drive the `useQuery` key/params) and `showVoided`/`setShowVoided`. Add:

```tsx
  const { rows: hookRows, search, filters, sort, setSearch, setFilter, toggleSort, reset, activeCount } =
    useTableControls(raw ?? [], INVOICE_CONTROLS);

  // voided handling: hide voided unless the toggle is on OR the status filter explicitly selects "voided"
  const invoices = useMemo(() => {
    const hideVoided = !showVoided && !(filters.status ?? []).includes("voided");
    return hideVoided ? hookRows.filter((i) => i.status !== "voided") : hookRows;
  }, [hookRows, showVoided, filters.status]);
```

Keep `totalValue`/`openValue`/`unlinkedCount` deriving from `invoices` (the final visible set).

- [ ] **Step 3: Replace the control row**

```tsx
      <FilterBar activeCount={activeCount} onClear={reset}>
        <SearchInput value={search.q ?? ""} onChange={(v) => setSearch("q", v)} placeholder="Search invoice # or customer…" />
        <YearSelect year={year} onChange={setYear} />
        {/* source stays a fetch param */}
        <FilterSelect label="Source"
          options={[{value:"square",label:"Square"},{value:"quickbooks",label:"QuickBooks"}]}
          value={source === "all" ? [] : [source]} onChange={(v) => setSource((v[0] as typeof source) ?? "all")} />
        <FilterSelect label="Status"
          options={[{value:"open",label:"Open",className:INVOICE_STATUS_CLS.open},{value:"paid",label:"Paid",className:INVOICE_STATUS_CLS.paid},{value:"partial",label:"Partial",className:INVOICE_STATUS_CLS.partial},{value:"voided",label:"Voided",className:INVOICE_STATUS_CLS.voided}]}
          value={filters.status ?? []} onChange={(v) => setFilter("status", v)} />
        <FilterSelect label="Type"
          options={[{value:"standard",label:"Standard",className:INVOICE_TYPE_CLS.standard},{value:"deposit",label:"Deposit",className:INVOICE_TYPE_CLS.deposit},{value:"export",label:"Export",className:INVOICE_TYPE_CLS.export}]}
          value={filters.type ?? []} onChange={(v) => setFilter("type", v)} />
        <MappingFilter value={(filters.mapping?.[0] as MappingFilterValue) ?? "all"}
          onChange={(v) => setFilter("mapping", v === "all" ? [] : [v])} />
        <button onClick={() => setShowVoided((s) => !s)} className="…keep existing toggle classes…">{showVoided ? "Hide voided" : "Show voided"}</button>
      </FilterBar>
```

(Match the actual `INVOICE_STATUS_CLS`/`INVOICE_TYPE_CLS`/`InvoiceType` value keys in the file — the labels/values above are indicative; use the real enum values. `source` FilterSelect: `[]` = "all" via the auto "All" option.)

- [ ] **Step 4: Swap the 7 sort headers** to shared `<SortableTh sort={sort} onSort={toggleSort}>` (keys as in config).

- [ ] **Step 5: Gate + commit**

Gate as Task 1. Commit `refactor(finance): Invoices ledger onto shared search/filter/sort primitives`.

---

### Task 3: Expenses

**Files:** Modify `app/finance/transactions/expenses/page.tsx`

**Context:** Real `<table>`. `year` (fetch param), `mappingFilter` (predicate), `sort = useTableSort<SortKey>("date")` with `date|merchant|state|amount`. Stats (`totalCount`/`mappedCount`/`totalSpend`) from UNFILTERED `expenses` — keep. Add search over `merchant_name` (field-coded).

- [ ] **Step 1: Imports + config (module scope)**

```tsx
// same shared imports as Task 1
const EXPENSE_CONTROLS: ControlsConfig<ExpenseRow> = {
  search: [{ param: "q", accessor: (e) => e.merchant_name ?? "" }],
  filters: [
    { param: "mapping", matches: (e, sel) => matchesMappingFilter(sel[0] as MappingFilterValue, e.chart_of_accounts_id ? 1 : 0, 1) },
  ],
  sort: {
    columns: [
      { key: "date", accessor: (e) => e.accounting_date ?? "" },
      { key: "merchant", accessor: (e) => e.merchant_name ?? "" },
      { key: "state", accessor: (e) => e.state ?? "" },
      { key: "amount", accessor: (e) => e.amount_cents },
    ],
    default: { key: "date", dir: "desc" },
  },
};
```

- [ ] **Step 2: Wire hook**

Remove `mappingFilter`/`sort` state + `visibleExpenses` chain; keep `year`. Add `const { rows: visibleExpenses, search, filters, sort, setSearch, setFilter, toggleSort, reset, activeCount } = useTableControls(expenses, EXPENSE_CONTROLS);`. Keep stats from unfiltered `expenses`.

- [ ] **Step 3: FilterBar** (SearchInput "Search merchant…" + `<YearSelect>` + `<MappingFilter>` driven from `filters.mapping`).

- [ ] **Step 4: Swap the 4 sort headers** to shared `SortableTh`.

- [ ] **Step 5: Gate + commit** `refactor(finance): Expenses ledger onto shared search/filter/sort primitives`.

---

### Task 4: Bank Ledger

**Files:** Modify `app/finance/transactions/bank-ledger/page.tsx`

**Context:** Real `<table>` (flat). `year` (fetch param), `sort = useTableSort<SortKey>("date")` with `date|amount`. No categorical filter today. `flow_type` is a bounded set (`FLOW_TYPES`) currently only used in a per-row editor. Add: field-coded search over the transaction identity (`counterparty_name` + `description`) and a `flow_type` categorical filter (net-new, standard-aligned — the one bounded dimension here).

- [ ] **Step 1: Imports + config (module scope)**

```tsx
// shared imports; also FilterSelect
const BANK_CONTROLS: ControlsConfig<BankRow> = {
  search: [{ param: "q", accessor: (r) => [r.counterparty_name, r.description] }],
  filters: [
    { param: "flow", accessor: (r) => r.flow_type },
  ],
  sort: {
    columns: [
      { key: "date", accessor: (r) => r.transaction_date ?? "" },
      { key: "amount", accessor: (r) => r.amount_cents },
    ],
    default: { key: "date", dir: "desc" },
  },
};
const FLOW_OPTIONS = FLOW_TYPES.map((f) => ({ value: f, label: /* existing FlowType label if any, else f */ f }));
```

- [ ] **Step 2: Wire hook**

Remove `sort` state + `visible` sort chain; keep `year`. Add `const { rows: visible, search, filters, sort, setSearch, setFilter, toggleSort, reset, activeCount } = useTableControls(rows, BANK_CONTROLS);`. Keep `needsReview`/`plNet` from unfiltered `rows` (unchanged).

- [ ] **Step 3: FilterBar** (SearchInput "Search counterparty…" + `<YearSelect>` + a `FilterSelect label="Flow" options={FLOW_OPTIONS}`). Do NOT touch the per-row `flow_type` editor `<select>` inside table rows.

- [ ] **Step 4: Swap the 2 sort headers** to shared `SortableTh` (date, amount).

- [ ] **Step 5: Gate + commit** `refactor(finance): Bank Ledger onto shared search/filter/sort primitives (+ flow filter)`.

---

### Task 5: Retire the local sort primitive from LedgerTable

**Files:** Modify `app/finance/transactions/components/LedgerTable.tsx`

**Context:** After Tasks 1–4, `useTableSort` and the local `SortableTh` in `LedgerTable.tsx` have no more consumers. Remove them; keep `LedgerTable` (table shell), `Th`, `CategoryBadge`, `CategoryBadges`, and any other still-used exports.

- [ ] **Step 1: Verify no remaining importers**

Run: `grep -rn "useTableSort\|SortableTh" app/finance/` — the only hits should be `LedgerTable.tsx`'s own definitions (Tasks 1–4 now import `SortableTh` from `@/app/components/ui`). If any finance page still imports the local `SortableTh`/`useTableSort`, STOP — that page wasn't migrated.

- [ ] **Step 2: Delete `useTableSort` and the local `SortableTh`**

Remove the `useTableSort` function and the local `SortableTh` component (and the `SortDir`/sort types they use if now unused) from `LedgerTable.tsx`. Keep everything else. Update the file's exports accordingly.

- [ ] **Step 3: Gate + commit**

`npx tsc --noEmit && npm run build && npm run lint && npm run test`. Commit `refactor(finance): drop unused local useTableSort/SortableTh from LedgerTable`.

---

## Definition of Done (PR 3)

- [ ] `npm run test` passes; `tsc` clean; lint 0 errors; `build` succeeds (all routes; handle any Suspense need).
- [ ] `grep -rn "useTableSort" app/` returns nothing (the local primitive is gone); `grep -rn 'from "../components/LedgerTable"' app/finance/transactions` no longer pulls `SortableTh`/`useTableSort`.
- [ ] `npm run check:search-filter` — no new violations (finance had zero; remaining warns = the 2 API-route false-positives + `SortControls.tsx`, both PR 4).
- [ ] **Browser verification (controller):** each transactions table — sort columns toggle, MappingFilter/status/type/source/flow filters narrow rows, field-coded search works, Show/Hide voided (invoices) behaves, summary stats reflect the intended set (invoices = filtered; orders/expenses/bank = unfiltered), URL updates + reload restores state.

## Out of scope
- model / sales / statements (LIGHT tier — left as-is).
- payroll / settings net-new search/sort (deferred).
- PR 4: taproom remainder + delete `app/reports/components/SortControls.tsx` + PartnersTab reshell + flip guard to `--strict` (refine its `.includes` rule for the 2 API-route false-positives).

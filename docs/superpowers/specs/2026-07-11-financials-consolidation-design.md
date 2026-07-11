# Financials Tab Consolidation — Design Spec

- **Date:** 2026-07-11
- **Status:** Approved design (pre-implementation-plan)
- **Scope:** Collapse the Finance area's **Model**, **Sales**, and **Statements** tabs into one cohesive **Financials** view, driven by a single authoritative basis, so the user can (a) reconcile easily, (b) read overall business health at a glance, and (c) drill from a glance number all the way down to the chart of accounts and beyond.
- **Not in scope:** Transactions, Payroll, Settings tabs (the already-cleaned *inputs* layer); the CoA/auto-map plumbing; Balance-Sheet A/R derivation; the excise and `manual_net_sales_entries` feeds. All continue as-is.

---

## 1. Problem & Goals

### Today there are two parallel "truths" about revenue that can disagree
- **Statements** (`app/finance/statements/*`, `app/api/finance/statements/route.ts`, `lib/finance/pl.ts`) is the *accounting* view: it aggregates the persisted, cleaned inputs — `pos_line_items`, `invoice_line_items`, `expenses`, `square_refunds` — through the **chart of accounts** (`chart_of_accounts`, hierarchical via `parent_id`, sectioned via `statement_section`). This is the reconciled, GL-accurate basis.
- **Model + Sales** is the *operational analytics* view. **Model** (`app/finance/model/page.tsx`) has **no backend** — it re-fetches the two Sales endpoints and blends them client-side. **Sales/Taproom** and **Sales/Events** compute **live from Square** per request (`app/api/finance/sales/taproom/route.ts`, `.../events/route.ts`) and never touch the CoA. The three invoice channels (`app/api/finance/sales/invoices/route.ts` → `lib/finance/invoiceSalesReport.ts`) read the ledger with reconciliation drilldowns.

The same revenue is therefore computed **two different ways**, and nothing forces them to reconcile. That is the deepest accuracy problem the consolidation must resolve.

### What each layer is uniquely good at (must be preserved)
- **Model** — glanceable month-over-month (MoM) spreadsheet roll-up. Clean, but unreconciled and backendless.
- **Statements** — GL-accurate, full CoA specificity, proper P&L / Balance Sheet / Cash Flow structure.
- **Sales** — dimensions the **CoA cannot express**: channel (taproom / events / contract-brewing / distribution / wholesale), POS category, keg size, and **BBL volume**, plus reconciliation banners (`UnrecognizedBanner`, `exciseCoverage`). This is the "drill *below* the chart of accounts" value.

### Goals
1. **Reconciliation by construction** — a channel roll-up and its GL roll-up are the *same number* because they are the *same rows grouped differently*.
2. **Health at a glance** — KPI strip + clean MoM roll-up for outlier spotting and business decisions.
3. **Progressive depth** — one screen digs from glance → statement sections → CoA accounts → operational slice (channel / category / volume) → underlying transactions.
4. **Spreadsheet feel** — mimic a real FP&A model (rows = line items, columns = months + Total).

---

## 2. Core decision: a single CoA-mapped spine

**Decision (approved):** Every number in the Financials view derives from the **persisted, CoA-mapped rows** (the Statements basis). The operational dimensions Sales adds become **orthogonal groupings of the same rows**, not a parallel dataset.

### Why "orthogonal," precisely
The chart of accounts answers *"what kind of money is this?"* (Draft Beer Sales, Merch, COGS, Rent). Channel / POS category / keg size / BBL volume are *attributes of the same line items* that **cross-cut** the CoA — e.g. "Draft Beer Sales" income has a taproom slice, a distribution slice, and a wholesale slice at once. Channel is **not** a sub-account under the CoA; it is a second dimension. This is why "by GL account" and "by channel" must resolve to the same underlying mapped rows.

### Consequences
- **Taproom repoints off live-Square onto `pos_line_items`** — the exact rows Statements already reads. The category / keg / BBL computations (`lib/reports/taproom-model.ts`, `lib/reports/kegs.ts`, `lib/reports/bbl-tracker.ts::canOzPerUnit`, draft-oz parsing) run **over persisted rows** instead of a live Square fetch. No math changes; only the input source.
- **Model's client-side blend is deleted** — the roll-up is computed once, server-side, from the single basis.
- **The reconciliation "bridge" is repurposed as a data-quality panel** — in a single-basis world the only reconciling items are *mapped vs not-yet-mapped / uncategorized / unknown-volume / stranded-deposit*. These are **rows to fix**, not two engines that disagree (see §7).

### Feasibility dependency (planning gate, not an architecture change)
Option A's correctness hinges on `pos_line_items` sync being **complete and trustworthy** as the taproom source of record. **Before implementation, verify sync coverage** (row counts / gross totals: persisted `pos_line_items` vs a live-Square control pull for a sample of months). If gaps exist, close them first. This does not change the design; it sequences the work.

---

## 3. Information architecture

### Navigation
Finance top-nav (`app/finance/nav-config.ts`) goes from:

```
[ Model · Sales · Statements · Transactions · Payroll · Settings ]
```
to:
```
[ Financials · Transactions · Payroll · Settings ]
```

`Financials` fully replaces Model + Sales + Statements (no light sub-nav — confirmed). The three canonical statements live behind an **in-view selector**, not separate routes.

### Progressive-disclosure depth model
- **L0 — Health strip:** KPI tiles (see §6.2) with outlier flags. *(the glance)*
- **L1 — Statement roll-up:** big MoM sections (Revenue → COGS → Gross Profit → Operating Expenses → Net Income). *(Model's clean feel)*
- **L2 — Expand a section → CoA accounts** (parent → child, from `chart_of_accounts.parent_id`). *(Statements' rigor)*
- **L3 — Slice a row by the secondary dimension → channel / POS category / keg size**, nested vertically beneath the account with month columns preserved. *(Sales' depth)*
- **L4 — Jump to underlying transactions** — deep-link into the Transactions tab, filtered. *(audit trail)*

### Top-level layout (statement-primary spreadsheet — confirmed)
```
[ KPI strip: Net Income · Gross Margin% · Revenue ⤴ · Operating Cash · Cash on hand ]
[ P&L | Balance Sheet | Cash Flow ]      [ measure: $ | BBL | $/BBL ]   [ data-quality ⚑ ]
[ FilterBar: SearchInput(account) · FilterChips(channel) · FilterSelect(section) · Clear(N) ]
                                Jan    Feb    Mar   …   Total
▾ Revenue                       ...    ...    ...       ...
   ▾ Draft Beer Sales           ...    ...    ...       ...      ← L2 CoA account
        taproom                 ...    ...    ...       ...      ← L3 channel slice
        distribution            ...    ...    ...       ...
        wholesale               ...    ...    ...       ...
     COGS                       ...
     Gross Profit               ...
     Operating Expenses         ...
     Net Income                 ...
```

---

## 4. Data spine (backend)

### New module: `lib/finance/financials/`
A single service that assembles the unified basis, building on the existing `lib/finance/pl.ts` math. It **replaces** these read paths:
- `app/api/finance/statements/route.ts` (P&L / BS / CF)
- `app/api/finance/sales/taproom/route.ts`, `.../events/route.ts`, `.../invoices/route.ts`
- Model's two-endpoint client blend (`app/finance/model/page.tsx`)

### Inputs (all persisted, all already CoA-mapped)
`pos_line_items`, `invoice_line_items` (incl. deposit BS/PL recognition via `bs_chart_of_accounts_id` / `pl_chart_of_accounts_id` / `delivery_invoice_id`), `expenses`, `square_refunds`, `ramp_bank_ledger`, joined to `chart_of_accounts`. Channel/volume context from `export_transactions` (`.channel`, `.volume_bbl`, `.quantity`) and excise from `export_transaction_taxes`. Manual adjustments continue from `manual_net_sales_entries`.

### Sign normalization (centralized here)
Today sign conventions differ by source: POS/invoice amounts are **unsigned-positive** (direction implied by the mapped account's `statement_section`); `expenses.amount_cents` and `ramp_bank_ledger.amount_cents` are **signed by cash direction**. The financials service normalizes **once** into a single convention keyed off `statement_section` (income positive, contra/expense negative), so downstream grouping never re-derives sign. This is the one place the two conventions meet.

### Output row model (sketch — signatures, not bodies)
```ts
// lib/finance/financials/types.ts
type StatementKind = "pl" | "balance_sheet" | "cash_flow";
type Measure = "amount" | "bbl" | "amount_per_bbl";
type Channel = "taproom" | "events" | "contract_brewing" | "distribution" | "wholesale" | "unknown";

interface FinancialsRow {
  coaId: string | null;              // chart_of_accounts.id; null => unmapped
  parentId: string | null;          // for tree building
  accountName: string;
  statementSection: string;          // resolved (explicit or account_type-derived)
  // dimensions (orthogonal to the CoA):
  channel: Channel;
  posCategory: string | null;
  kegSize: "half" | "quarter" | "sixth" | "can" | null;
  // measures, per month + total:
  amountCentsByMonth: Record<string /*YYYY-MM*/, number>;  // sign-normalized
  bblByMonth: Record<string, number>;
  bblCoverage: "full" | "partial" | "unknown";             // gates $/BBL (see §5)
  // provenance for L4 + data quality:
  mappingSource: "manual" | "rule" | "unmapped";
  sourceRef: { table: string; ids: string[] };
}

interface FinancialsResponse {
  months: string[];                 // ["2026-01", …], capped to trailing 12
  rows: FinancialsRow[];            // FLAT; client builds the tree
  dataQuality: DataQualitySummary;  // see §7
  kpis: KpiSummary;                 // see §6.2
}

function buildFinancials(
  params: { statement: StatementKind; year: number },
): Promise<FinancialsResponse>;      // lib/finance/financials/buildFinancials.ts
```

### Endpoint
`GET /api/finance/financials?statement=pl|balance_sheet|cash_flow&year=YYYY` → `FinancialsResponse`. Balance-Sheet mode returns cumulative-from-inception balances (single Total column semantics preserved from today's BS page); Cash-Flow mode filters invoices to `status='paid'` and expenses to `state='CLEARED'` (preserved from today's cash view).

---

## 5. Dimension & measure model

### Channel (derived, not a new source of truth)
- `invoice_id IS NULL` on a POS row → **taproom** (except event-pour items → **events**, matching today's `event pour` catalog-name rule).
- Invoice-backed rows → `export_transactions.channel` → **contract_brewing / distribution / wholesale**.
- Anything underivable → **unknown** (surfaces in the data-quality panel).

### POS category / keg size
From the catalog (`lib/constants/categories`, `lib/reports/taproom-model.ts`) and keg detection (`lib/reports/kegs.ts`), computed over persisted rows.

### Volume measure & the $/BBL rider (approved)
- Measure toggle: **`$` / `BBL` / `$-per-BBL`** on the P&L only ($-only on BS/CF).
- **Volume is two-tier reliability:** explicit on the invoice/export side (`export_transactions.volume_bbl`, `.quantity`), heuristic on the taproom POS side (parsed from catalog names). Because `$/BBL` is a ratio, a mis-parsed denominator is misleading exactly where it's trusted.
- **Rider:** `bblCoverage` (`full | partial | unknown`) is a **first-class data-quality signal** alongside GL-mapping coverage. A beer row whose BBL can't be fully parsed renders its `$/BBL` cell **flagged** (not silently wrong), and contributes to the "unknown-volume" bucket in the data-quality panel (§7). The `$` and `BBL` measures individually are no less reliable than what Sales ships today — only the *derived* ratio is gated.

---

## 6. The view (frontend)

### 6.1 Components
- New `app/finance/financials/page.tsx` (client) + a **single** shared MoM table component `app/finance/financials/FinancialsTable.tsx` that **replaces all three** current renderers (`sales/SalesTable.tsx`, `statements/lib.tsx` MoM components, and the Balance-Sheet page's bespoke recursive rows).
- Tree building moves to a shared `buildTree` over `FinancialsRow[]` (generalize today's `statements/lib.tsx::buildTree`).
- Uses **react-query** via a new `queryKeys.finance.financials(statement, year)` (extends `lib/query-keys.ts`), so caching matches the rest of Finance (today Statements uses raw `fetch`+`useState` — this cleans that up).

### 6.2 KPI health strip (defaults — adjustable)
Net Income (+MoM Δ), Gross Margin %, Revenue (+MoM growth), Operating Cash Flow, Cash on hand (from BS). Outlier flags = MoM delta beyond a threshold. Computed server-side in `KpiSummary` so the strip and the statement never disagree.

### 6.3 Interaction
- Statement selector (P&L / BS / CF) — a `TabBar`/`SubNav`-style control (per UI standard), switches `statement` query param.
- Expand/collapse at section and account level; L3 channel/category nesting on demand.
- Measure toggle ($/BBL/$per-BBL).
- Data-quality entry point (⚑) opens the panel (§7).

---

## 7. Data-quality / reconciliation panel

Generalizes today's `UnrecognizedBanner` + `exciseCoverage` + `lib/finance/mappingStatus.ts` into one persistent, unobtrusive surface. `DataQualitySummary` reports counts + dollar totals for each bucket, each **deep-linking to the Transactions filter that fixes it**:

```ts
interface DataQualitySummary {
  unmapped:        { count: number; cents: number; href: string }; // no chart_of_accounts_id
  uncategorized:   { count: number; cents: number; href: string }; // channel === "unknown"
  unknownVolume:   { count: number; cents: number; href: string }; // bblCoverage !== "full" on beer rows
  strandedDeposit: { count: number; cents: number; href: string }; // bs_chart_of_accounts_id set, no delivery link
  exciseCoverage:  { shipmentsMissingExcise: number; href: string };
}
```

This **is** the reconciliation experience: it points at rows to fix, not at a methodology delta.

---

## 8. Search / filter / sort — using the app standard (required)

The consolidated view **must** use the enforced standard (`lib/table/*`, `app/components/ui/useTableControls.ts`, `SearchInput` / `FilterChips` / `FilterSelect` / `SortableTh` / `FilterBar`) — the CI guard `scripts/check-search-filter.mjs --strict` blocks raw search inputs, inline `.toLowerCase().includes` filtering, and hand-rolled sort headers / filter chips.

### Adapting a flat-table standard to a hierarchical statement
`applyControls<T>(rows, config, state)` filters/sorts a **flat** array. A statement is a **tree**. Resolution:
1. Run **search + filter** over the flat `FinancialsRow[]` via `useTableControls(rows, config, { prefix: "fin_" })`.
2. **Rebuild the tree from survivors, retaining ancestors** of any matched row (so an expense match still shows under "Operating Expenses").
3. **Sort:** default is canonical statement order (section order, then `account_number`). An optional amount-sort via `SortableTh` on month/Total columns reorders **leaves within their parent section** only (never across sections — a statement's section order is fixed).

### Control config (sketch)
```ts
const FINANCIALS_CONTROLS: ControlsConfig<FinancialsRow> = {
  search: [{ param: "q", accessor: (r) => r.accountName }],
  filters: [
    { param: "channel", accessor: (r) => r.channel, multi: true },
    { param: "section", accessor: (r) => r.statementSection },
    { param: "quality", matches: (r, sel) => sel.includes(qualityBucket(r)) }, // unmapped/uncategorized/…
  ],
  sort: { columns: [ /* Total + per-month keys */ ], default: null /* canonical */ },
};
```
- `SearchInput` → account-name search ("Search accounts…").
- `FilterChips` → channel (segmented, multi).
- `FilterSelect` → statement section (dropdown; > ~5 options).
- The **data-quality panel filter** reuses the same `quality` dimension so "show me only unmapped rows" is one click.

---

## 9. Consistency cleanups folded in (scoped, not gratuitous)
- Collapse **three** table renderers into **one** (`FinancialsTable.tsx`).
- Move Statements onto **react-query** (kills raw `fetch`+`useState`).
- One `queryKeys.finance.financials` entry replacing `salesTaproom` / `salesEvents` / `salesInvoices` / statements fetches.
- Delete Model's client-side blend and the superseded Sales/Statements routes once parity is verified.

---

## 10. Out of scope (explicit)
Payroll, Settings, Transactions tabs; CoA/auto-map plumbing; Balance-Sheet A/R derivation logic; excise and `manual_net_sales_entries` ingestion. All continue as-is and feed the new spine unchanged.

---

## 11. Open questions / planning gates
1. **`pos_line_items` sync-coverage verification** (§2) — the one gate that must pass before repointing taproom. Design is unaffected; sequencing depends on the result.
2. **Migration/rollout:** build the new spine + view behind parity checks against the current tabs (same year → same numbers within tolerance), then flip nav and delete superseded routes. Old routes stay until parity is signed off.
3. **`$/BBL` flag styling** — exact treatment of a `partial`/`unknown` volume cell (tooltip vs muted vs badge) is a UI-standard detail for implementation.

---

## 12. Acceptance criteria
- Finance top-nav shows `Financials · Transactions · Payroll · Settings`; Model/Sales/Statements routes redirect into `Financials`.
- A single endpoint `/api/finance/financials` serves P&L, BS, and CF from the persisted CoA-mapped basis.
- For any month, **channel roll-up total === GL roll-up total === statement section total** (reconciliation by construction), within rounding.
- Taproom figures derive from `pos_line_items` (not a live-Square fetch) and match the pre-consolidation Statements numbers within tolerance.
- Measure toggle produces `$`, `BBL`, and `$/BBL`; `$/BBL` cells with non-`full` volume coverage are visibly flagged.
- Data-quality panel lists unmapped / uncategorized / unknown-volume / stranded-deposit / excise-coverage buckets, each deep-linking to Transactions.
- All search/filter/sort routes through the shared standard; `npm run check:search-filter -- --strict` passes.
- `npm run verify` (lint + typecheck + tests) passes; new `lib/finance/financials/*` ships with co-located `*.test.ts` covering the pure paths.

## 13. Test cases (pure logic — co-located `*.test.ts`)
- **Sign normalization:** income row → positive; expense row → negative; contra-revenue (`square_refunds`) → negative; regardless of source sign convention.
- **Reconciliation invariant:** given a fixed set of mapped rows, summing by `channel` equals summing by `coaId` equals the section subtotal.
- **Channel derivation:** POS `invoice_id IS NULL` → taproom; event-pour → events; invoice-backed → `export_transactions.channel`; underivable → unknown.
- **Volume coverage gating:** a beer row with unparseable BBL → `bblCoverage: "unknown"` and excluded from a trustworthy `$/BBL` (flagged), while its `$` and `BBL` still aggregate.
- **Tree rebuild from filtered leaves:** filtering to a single expense account still renders its ancestor section; sorting by amount reorders leaves within a section but never across sections.
- **Deposit recognition:** a deposit line with `bs_chart_of_accounts_id` set and no `delivery_invoice_id` → BS + counted as stranded-deposit; once the delivery invoice is `paid` → recognized into P&L.

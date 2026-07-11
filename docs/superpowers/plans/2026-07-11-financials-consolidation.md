# Financials Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the Finance area's Model, Sales, and Statements tabs into one `Financials` view driven by a single CoA-mapped basis, so channel/category/volume roll-ups reconcile with the GL by construction.

**Architecture:** A new pure-logic + service layer (`lib/finance/financials/`) reads the already-persisted, CoA-mapped rows (`pos_line_items`, `invoice_line_items`, `expenses`, `square_refunds`, `ramp_bank_ledger`), normalizes sign once, and attaches orthogonal dimensions (channel, POS category, keg size, BBL volume) plus measures. One API route serves P&L/BS/CF. One React view renders a statement-primary MoM spreadsheet with progressive-disclosure drilldown, a `$/BBL` measure toggle, a data-quality panel, and the shared search/filter/sort standard. Old routes stay until parity is signed off, then get deleted.

**Tech Stack:** Next.js 16 (App Router, TS), Tailwind v4, Supabase Postgres (admin client for finance), react-query, vitest. Square via `lib/square/*` (read only where still needed).

**Spec:** `docs/superpowers/specs/2026-07-11-financials-consolidation-design.md` — the source of truth for behavior. Read it before executing.

## Global Constraints

- **Next.js 16 conventions** differ from training data — read `docs/nextjs16-deltas.md` before writing routes/pages.
- **No business logic in `app/api/**` or page components** — all assembly logic lives in `lib/finance/financials/`.
- **API routes** parse params with `requireDateRange()` / return errors with `apiError()` (`lib/utils/api.ts`).
- **Supabase client by context:** route handlers/services use `createSupabaseAdminClient` (`lib/supabase/admin.ts`) — never the browser client server-side.
- **UI:** token utilities only (no raw `zinc/amber/red/green/blue/gray` or hex); shared primitives from `app/components/ui/` + `app/components/`; buttons `.btn-*`, inputs `.inp`, `<PageHeader>`, `<Card>`, `<Banner>`, `<Badge>`, `<SubNav>`/`<TabBar>`. Data-category/urgency palettes (channel colors) stay as raw category constants in ONE shared place.
- **Search/filter/sort:** MUST route through `lib/table/*` + `app/components/ui/{useTableControls,SearchInput,FilterChips,FilterSelect,SortableTh,FilterBar}`. `npm run check:search-filter -- --strict` must pass (blocks raw search inputs, inline `.toLowerCase().includes`, hand-rolled sort headers/filter chips).
- **Tests:** new/modified `lib/` modules ship co-located `*.test.ts` covering pure paths; don't drop coverage below `vitest.config.ts` floor.
- **DoD per task:** `npm run verify` (lint + typecheck + tests) passes.
- **Money:** integer cents end-to-end; a single ÷100 at the presentation boundary (follow `lib/finance/pl.ts`).
- **Reconciliation invariant (non-negotiable):** for any month, `sum by channel === sum by coaId === statement section subtotal`, within rounding.

---

## Task Table

| # | Task | Group | Model | Depends on |
|---|------|-------|-------|-----------|
| 0 | Verify `pos_line_items` sync coverage (spike/gate) | Gate | Sonnet | — |
| 1 | Financials types + sign normalization (pure) | A: spine | Sonnet | 0 |
| 2 | Dimension derivation: channel / POS category / keg size (pure) | A: spine | Sonnet | 1 |
| 3 | Volume measure + `$/BBL` coverage gating (pure) | A: spine | Sonnet | 1 |
| 4 | Row aggregation: persisted rows → `FinancialsRow[]` | A: spine | Sonnet | 1,2,3 |
| 5 | KPI + data-quality summaries (pure) | A: spine | Sonnet | 4 |
| 6 | `buildFinancials` orchestration (pl/bs/cf modes) | A: spine | Sonnet | 4,5 |
| 7 | `GET /api/finance/financials` route | B: API | Sonnet | 6 |
| 8 | Parity harness: new basis vs current tabs | B: API | Sonnet | 7 |
| 9 | `buildTree` + `FinancialsTable` single MoM renderer | C: view | Sonnet | 7 |
| 10 | Financials page shell: selector + KPI strip + measure toggle | C: view | Sonnet | 9 |
| 11 | Search/filter/sort integration (tree-rebuild-from-survivors) | C: view | Sonnet | 9,10 |
| 12 | Data-quality panel component | C: view | Sonnet | 10 |
| 13 | Nav flip + Model/Sales/Statements → Financials redirects | D: cutover | Haiku | 10,11,12 |
| 14 | Delete superseded routes + Model blend (post-parity) | D: cutover | Haiku | 8,13 |
| 15 | Final whole-branch review | Review | Opus | all |

Per-task review: Sonnet (findings-only). Skip per-task review for Task 13 (config/nav) and Task 14 (deletions) unless the reviewer flags a dangling import.

---

## Task 0: Verify `pos_line_items` sync coverage (gate)

**Goal:** Confirm persisted `pos_line_items` is complete enough to replace the live-Square taproom read path. This is the one feasibility gate (spec §2, §11). Design does not change; sequencing does.

**Files:**
- Create: `scripts/verify-pos-sync-coverage.mjs` (throwaway diagnostic; may be deleted after)

**Steps:**
- [ ] **Step 1:** For 3 sample months, compute taproom gross from persisted `pos_line_items` (filter `invoice_id IS NULL`) vs a live-Square control pull using the same fetchers the current taproom route uses (`fetchCompletedOrders` + category logic). Report per-month deltas.
- [ ] **Step 2:** Classify any delta: sync lag (recent months), missing catalog mapping, or genuine gap.
- [ ] **Step 3 (decision):** If deltas are within rounding for closed months → proceed with the plan as written. If material gaps → STOP and surface to the user; add a sync-backfill task before Task 4. Do not silently proceed.

**Acceptance:** A written finding (paste into the executing session) stating persisted vs live deltas per sample month and a go/no-go on repointing taproom.

---

## Task 1: Financials types + sign normalization (pure)

**Files:**
- Create: `lib/finance/financials/types.ts`, `lib/finance/financials/normalizeSign.ts`
- Test: `lib/finance/financials/normalizeSign.test.ts`

**Interfaces — Produces:**
```ts
type StatementKind = "pl" | "balance_sheet" | "cash_flow";
type Measure = "amount" | "bbl" | "amount_per_bbl";
type Channel = "taproom" | "events" | "contract_brewing" | "distribution" | "wholesale" | "unknown";
type BblCoverage = "full" | "partial" | "unknown";
type MappingSource = "manual" | "rule" | "unmapped";

interface FinancialsRow {
  coaId: string | null; parentId: string | null; accountName: string; statementSection: string;
  channel: Channel; posCategory: string | null; kegSize: "half" | "quarter" | "sixth" | "can" | null;
  amountCentsByMonth: Record<string, number>;   // sign-normalized cents, key "YYYY-MM"
  bblByMonth: Record<string, number>; bblCoverage: BblCoverage;
  mappingSource: MappingSource; sourceRef: { table: string; ids: string[] };
}
interface FinancialsResponse { months: string[]; rows: FinancialsRow[]; dataQuality: DataQualitySummary; kpis: KpiSummary; }

// normalizeSign: given a raw amount + its statement section + source, return sign-normalized cents.
// Convention: income/other_income positive; cogs/expense/other_expense negative; contra-revenue negative.
function normalizeSignedCents(rawCents: number, statementSection: string, source: "pos" | "invoice" | "expense" | "bank" | "refund"): number;
```

**Steps:**
- [ ] **Step 1 (test-first):** Cases: POS income (unsigned positive input) → positive; expense (already-signed negative input) → negative; `square_refunds` contra-revenue → negative; bank `interest_income` → positive. Assert the function reconciles the two source conventions (POS/invoice unsigned-positive vs expense/bank signed) into one.
- [ ] **Step 2:** Run test → FAIL (not implemented).
- [ ] **Step 3:** Implement per the convention above (≤20 lines; a section→sign map + source-aware absolute-value handling).
- [ ] **Step 4:** Run test → PASS. `npm run verify`.
- [ ] **Step 5:** Commit `feat(finance): financials row types + sign normalization`.

**Acceptance:** All four source conventions normalize to one signed convention keyed off statement section.

---

## Task 2: Dimension derivation (pure)

**Files:**
- Create: `lib/finance/financials/dimensions.ts`
- Test: `lib/finance/financials/dimensions.test.ts`

**Interfaces — Consumes:** `Channel`, keg-size type (Task 1). **Produces:**
```ts
function deriveChannel(row: { invoiceId: string | null; isEventPour: boolean; exportChannel: string | null }): Channel;
function derivePosCategory(variation: { categoryId: string | null }): string | null;   // reuse lib/constants/categories
function deriveKegSize(variationName: string): "half" | "quarter" | "sixth" | "can" | null; // reuse lib/reports/kegs.ts helpers
```

**Steps:**
- [ ] **Step 1 (test-first):** `deriveChannel`: `invoiceId=null, isEventPour=false` → `taproom`; `isEventPour=true` → `events`; `invoiceId` set + `exportChannel="distribution"` → `distribution`; export channel missing/unknown → `unknown`. `deriveKegSize`: name containing 1/2 bbl → `half`, etc.; unmatched → `null`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement, reusing `lib/reports/kegs.ts` and `lib/constants/categories` (do NOT re-implement keg parsing — import it).
- [ ] **Step 4:** Run → PASS. `npm run verify`.
- [ ] **Step 5:** Commit `feat(finance): orthogonal dimension derivation`.

**Acceptance:** Channel derivation matches spec §5; keg/category reuse existing modules (no duplicate parsers).

---

## Task 3: Volume measure + `$/BBL` coverage gating (pure)

**Files:**
- Create: `lib/finance/financials/volume.ts`
- Test: `lib/finance/financials/volume.test.ts`

**Interfaces — Produces:**
```ts
// bbl for invoice/export rows: explicit (export_transactions.volume_bbl). For taproom: parsed via existing helpers.
function rowBbl(row): { bbl: number; coverage: BblCoverage };   // coverage="unknown" when a beer row's bbl can't be parsed
function amountPerBbl(amountCents: number, bbl: number, coverage: BblCoverage): { valueCents: number | null; flagged: boolean };
```

**Steps:**
- [ ] **Step 1 (test-first):** Invoice row with explicit `volume_bbl` → `coverage="full"`. Taproom beer row with unparseable BBL → `coverage="unknown"`, and `amountPerBbl` returns `{ valueCents: null, flagged: true }`. Non-beer row (merch) → bbl 0, not flagged (not a beer row). Full-coverage beer row → real `$/BBL`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; `$/BBL` is gated — never divide when coverage !== "full" on a beer row (return null + flagged).
- [ ] **Step 4:** Run → PASS. `npm run verify`.
- [ ] **Step 5:** Commit `feat(finance): volume measure with $/BBL coverage gating`.

**Acceptance:** `$/BBL` is never silently computed on partial/unknown volume; `$` and `BBL` still aggregate independently (spec §5 rider).

---

## Task 4: Row aggregation → `FinancialsRow[]`

**Files:**
- Create: `lib/finance/financials/aggregateRows.ts`
- Test: `lib/finance/financials/aggregateRows.test.ts` (against fixture rows, not live DB)

**Interfaces — Consumes:** Tasks 1–3. **Produces:**
```ts
// Pure over already-fetched source records + CoA. The DB fetch lives in Task 6; this is the mapping/aggregation.
function aggregateRows(input: {
  pos: PosLineRecord[]; invoiceLines: InvoiceLineRecord[]; expenses: ExpenseRecord[];
  refunds: RefundRecord[]; bank: BankLedgerRecord[]; coa: CoaRecord[]; months: string[];
}): FinancialsRow[];
```

**Steps:**
- [ ] **Step 1 (test-first):** Fixture with one income variation sold in taproom + distribution across 2 months → two `FinancialsRow`s (same `coaId`, different `channel`), correct `amountCentsByMonth`. Deposit line with `bs_chart_of_accounts_id` set, no `delivery_invoice_id` → row carries BS section + `mappingSource` intact (stranded, handled in Task 5). Unmapped POS line (`coaId=null`) preserved, not dropped.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement: resolve effective CoA (manual override ?? mapping prefill, mirroring `app/api/finance/transactions/route.ts` resolution + `invoice_line_items` deposit `resolveCoaId`), apply `normalizeSignedCents`, attach dimensions (Task 2) + volume (Task 3), bucket by month.
- [ ] **Step 4:** Run → PASS. `npm run verify`.
- [ ] **Step 5:** Commit `feat(finance): aggregate persisted rows into unified financials rows`.

**Acceptance:** Same variation across channels → same `coaId`, split by `channel` (reconciliation-by-construction precondition). Unmapped/stranded rows retained.

---

## Task 5: KPI + data-quality summaries (pure)

**Files:**
- Create: `lib/finance/financials/summaries.ts`
- Test: `lib/finance/financials/summaries.test.ts`

**Interfaces — Produces:**
```ts
interface KpiSummary { netIncomeCents: Record<string,number>; grossMarginPct: Record<string,number>;
  revenueCents: Record<string,number>; revenueMoMPct: Record<string,number>;
  operatingCashCents: Record<string,number>; cashOnHandCents: number | null; }
interface DataQualitySummary {
  unmapped: { count: number; cents: number; href: string }; uncategorized: { count: number; cents: number; href: string };
  unknownVolume: { count: number; cents: number; href: string }; strandedDeposit: { count: number; cents: number; href: string };
  exciseCoverage: { shipmentsMissingExcise: number; href: string };
}
function buildKpis(rows: FinancialsRow[], months: string[]): KpiSummary;
function buildDataQuality(rows: FinancialsRow[]): DataQualitySummary;
```

**Steps:**
- [ ] **Step 1 (test-first):** KPI: revenue MoM % correct across 2 months; gross margin = (rev − cogs)/rev. Data-quality: `coaId=null` → unmapped bucket count+cents; `channel="unknown"` → uncategorized; `bblCoverage!=="full"` on beer → unknownVolume; stranded deposit → strandedDeposit. Each `href` points to the right Transactions filter.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement (reuse `lib/finance/mappingStatus.ts` semantics where they exist; do not duplicate).
- [ ] **Step 4:** Run → PASS. `npm run verify`.
- [ ] **Step 5:** Commit `feat(finance): KPI + data-quality summaries`.

**Acceptance:** Buckets match spec §7; KPIs computed server-side so strip and statement can't disagree.

---

## Task 6: `buildFinancials` orchestration

**Files:**
- Create: `lib/finance/financials/buildFinancials.ts`, `lib/finance/financials/index.ts` (barrel)
- Test: `lib/finance/financials/buildFinancials.test.ts` (mock the DB fetch; assert wiring + statement-mode filters)

**Interfaces — Consumes:** Tasks 4–5. **Produces:**
```ts
function buildFinancials(params: { statement: StatementKind; year: number }): Promise<FinancialsResponse>;
```

**Steps:**
- [ ] **Step 1 (test-first):** With mocked source fetch: `statement="cash_flow"` filters invoices to `status='paid'` and expenses to `state='CLEARED'`; `balance_sheet` returns cumulative-from-inception balances (single Total semantics); `pl` returns trailing-12 months. Assert `months` cap at 12 and the reconciliation invariant on the fixture (Σ by channel === Σ by coaId).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement: fetch persisted rows via `createSupabaseAdminClient` (batch/join, minimize round-trips per Architecture Priorities), call `aggregateRows` → `buildKpis`/`buildDataQuality`, apply statement-mode filters. Keep the DB fetch thin; assembly stays in Tasks 4–5.
- [ ] **Step 4:** Run → PASS. `npm run verify`.
- [ ] **Step 5:** Commit `feat(finance): buildFinancials orchestration for pl/bs/cf`.

**Acceptance:** One service produces all three statements from the single basis; reconciliation invariant holds on fixtures.

---

## Task 7: `GET /api/finance/financials` route

**Files:**
- Create: `app/api/finance/financials/route.ts`
- Test: `app/api/finance/financials/route.test.ts` (or a lib-level integration test if route testing isn't set up — match existing finance route test pattern)

**Interfaces — Consumes:** Task 6. **Produces:** `GET /api/finance/financials?statement=pl|balance_sheet|cash_flow&year=YYYY` → `FinancialsResponse`.

**Steps:**
- [ ] **Step 1 (test-first):** Missing/invalid `statement` → `apiError` 400. Valid → `FinancialsResponse` shape. Admin-gate consistent with other finance routes.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement: thin handler — parse/validate params (`requireDateRange` where applicable + statement enum guard), call `buildFinancials`, return JSON via `apiError` on failure. No business logic here.
- [ ] **Step 4:** Run → PASS. `npm run verify`.
- [ ] **Step 5:** Commit `feat(finance): financials API route`.

**Acceptance:** Route is a thin adapter; validation + error conventions per `lib/utils/api.ts`.

---

## Task 8: Parity harness

**Files:**
- Create: `scripts/financials-parity.mjs` (kept in-repo through cutover; delete in Task 14 or keep as a check)

**Steps:**
- [ ] **Step 1:** For N closed months, compare new `/api/finance/financials` totals against current Statements route + Sales endpoints + Model blend for: total revenue, section subtotals, per-channel revenue, net income.
- [ ] **Step 2:** Emit a table of deltas; flag anything beyond rounding tolerance.
- [ ] **Step 3:** Investigate deltas → they are either (a) a genuine improvement (old dual-basis disagreement) or (b) a bug in the new spine. Document each; fix (b).
- [ ] **Step 4:** Commit `test(finance): financials parity harness`.

**Acceptance:** A signed-off parity report; every delta is explained (improvement vs bug), bugs fixed. **This gates Task 14 (deletion).**

---

## Task 9: `buildTree` + `FinancialsTable` single MoM renderer

**Files:**
- Create: `app/finance/financials/buildTree.ts`, `app/finance/financials/FinancialsTable.tsx`
- Test: `app/finance/financials/buildTree.test.ts`

**Interfaces — Consumes:** `FinancialsRow`, `Measure`. **Produces:**
```ts
interface TreeNode { row: FinancialsRow | null; label: string; children: TreeNode[]; depth: number; isSection: boolean; }
function buildTree(rows: FinancialsRow[], statement: StatementKind): TreeNode[];  // generalizes statements/lib.tsx::buildTree
// FinancialsTable: props { tree; months; measure; onExpand; onSliceRow }. Renders MoM rows + Total, expand/collapse,
// measure-aware cells ($/BBL/$per-BBL), flagged $/BBL cells. ONE renderer replacing SalesTable + statements/lib.tsx + BS bespoke rows.
```

**Steps:**
- [ ] **Step 1 (test-first):** `buildTree` groups rows into sections (Revenue/COGS/Gross Profit/OpEx/Net Income for pl; Assets/Liabilities/Equity for bs) and parent→child accounts; subtotal nodes computed. Channel slice rows nest under their account.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `buildTree` (pure) + `FinancialsTable.tsx` (token utilities, no raw colors; channel colors from one shared category-constant file). Measure toggle changes displayed cells only.
- [ ] **Step 4:** Run → PASS. `npm run verify`.
- [ ] **Step 5:** Commit `feat(finance): unified financials tree + MoM table`.

**Acceptance:** One table component renders all three statements; flagged `$/BBL` cells visibly distinct; no raw colors.

---

## Task 10: Financials page shell

**Files:**
- Create: `app/finance/financials/page.tsx`
- Modify: `lib/query-keys.ts` (add `finance.financials(statement, year)`)

**Interfaces — Consumes:** Tasks 7, 9. **Produces:** the `/finance/financials` page.

**Steps:**
- [ ] **Step 1:** Add `queryKeys.finance.financials` + a react-query fetch of the route (mirror existing finance query usage; `fetchJson`).
- [ ] **Step 2:** Compose page: `<PageHeader>`, statement selector (`<TabBar>`/`<SubNav>` per UI standard), KPI health strip (from `kpis`), measure toggle, `<FinancialsTable>`. Year picker mirrors current pages.
- [ ] **Step 3:** Verify in browser (preview workflow): P&L renders, selector switches to BS/CF, measure toggle switches $/BBL/$per-BBL, KPI strip populates. Capture a screenshot as proof.
- [ ] **Step 4:** `npm run verify`. Commit `feat(finance): financials page shell`.

**Acceptance:** Statement-primary layout matches spec §3; caching via react-query; browser-verified.

---

## Task 11: Search/filter/sort integration

**Files:**
- Modify: `app/finance/financials/page.tsx` (or a co-located `controls.ts` for the config)
- Create: `app/finance/financials/controls.ts`

**Interfaces — Consumes:** `useTableControls`, `applyControls`, `FilterBar`/`SearchInput`/`FilterChips`/`FilterSelect`/`SortableTh`.

**Steps:**
- [ ] **Step 1:** Define `FINANCIALS_CONTROLS: ControlsConfig<FinancialsRow>` — search on `accountName` (`q`), filters `channel` (multi, `FilterChips`), `section` (`FilterSelect`), `quality` (custom `matches` → unmapped/uncategorized/unknownVolume/strandedDeposit). Sort columns = Total + per-month keys; default `null` (canonical order).
- [ ] **Step 2:** Wire `useTableControls(rows, config, { prefix: "fin_" })`. **Tree-rebuild-from-survivors:** run `applyControls` over the flat rows, then `buildTree` from survivors **retaining ancestors** of matches. Amount-sort reorders leaves within a section only.
- [ ] **Step 3:** Render `<FilterBar activeCount onClear={reset}>` with the primitives; `<SortableTh>` in table header.
- [ ] **Step 4:** Run `npm run check:search-filter -- --strict` → PASS. Browser-verify: search "rent" collapses tree to that account under OpEx; channel chip filters; quality filter shows only unmapped.
- [ ] **Step 5:** `npm run verify`. Commit `feat(finance): search/filter/sort via shared standard`.

**Acceptance:** Guard passes; ancestor-retaining tree rebuild works; no hand-rolled controls.

---

## Task 12: Data-quality panel component

**Files:**
- Create: `app/finance/financials/DataQualityPanel.tsx`
- Modify: `app/finance/financials/page.tsx` (mount the ⚑ entry point)

**Interfaces — Consumes:** `DataQualitySummary` (from response), the `quality` filter dimension (Task 11).

**Steps:**
- [ ] **Step 1:** Render each bucket (unmapped/uncategorized/unknownVolume/strandedDeposit/exciseCoverage) with count + $ using `<Badge>`/`<Card>`/token utilities; each row deep-links to its Transactions `href`, and "show in table" applies the `quality` filter locally.
- [ ] **Step 2:** Browser-verify: panel opens from ⚑, buckets populate, a deep-link navigates to the right Transactions filter.
- [ ] **Step 3:** `npm run verify`. Commit `feat(finance): data-quality reconciliation panel`.

**Acceptance:** Matches spec §7; points at rows to fix.

---

## Task 13: Nav flip + redirects

**Files:**
- Modify: `app/finance/nav-config.ts` (replace Model/Sales/Statements entries with `Financials`)
- Modify/Create: `app/finance/model/page.tsx`, `app/finance/sales/**`, `app/finance/statements/**` → redirect to `/finance/financials` (preserve statement selection where sensible, e.g. `/statements/pl` → `?statement=pl`)

**Steps:**
- [ ] **Step 1:** Update `FINANCE_NAV` to `[Financials, Transactions, Payroll, Settings]`.
- [ ] **Step 2:** Replace old page bodies with `redirect()` to the consolidated view (Next.js 16 redirect per `docs/nextjs16-deltas.md`).
- [ ] **Step 3:** Browser-verify each old URL lands on Financials. `npm run verify`. Commit `feat(finance): flip finance nav to consolidated Financials`.

**Acceptance:** Old routes redirect; nav shows four tabs.

---

## Task 14: Delete superseded routes + Model blend (post-parity)

**Precondition:** Task 8 parity signed off.

**Files:**
- Delete: `app/api/finance/sales/taproom/route.ts`, `.../events/route.ts`, `.../invoices/route.ts`, `app/api/finance/statements/route.ts`, Model's blend logic, orphaned `sales/SalesTable.tsx` / `statements/lib.tsx` (only the parts fully replaced by `FinancialsTable`), and now-unused `queryKeys.finance.sales*`.

**Steps:**
- [ ] **Step 1:** Remove superseded routes/components/query-keys. Keep anything still referenced (e.g. `invoiceSalesReport.ts` if used elsewhere — grep first).
- [ ] **Step 2:** `npm run verify` (typecheck catches dangling imports) + `npm run build`. Commit `refactor(finance): remove superseded sales/statements/model paths`.

**Acceptance:** No dead references; build clean; only truly-replaced code removed.

---

## Task 15: Final whole-branch review (Opus)

- [ ] Single Opus review of the whole branch: reconciliation invariant upheld, no business logic in routes/pages, token/UI-standard compliance, search/filter guard green, no orphaned code, tests meaningful. Output findings only (severity + file:line + one-line fix).

---

## Self-Review (against spec)

- **§1 nav collapse** → Tasks 13, 14. **§2 single spine + sync gate** → Tasks 0, 1, 4, 6. **§3 IA/layout** → Tasks 9, 10. **§4 backend service + sign norm + replaced routes** → Tasks 1, 4, 6, 7, 14. **§5 dimensions + $/BBL rider** → Tasks 2, 3. **§6 view + KPI + single renderer + react-query** → Tasks 5, 9, 10. **§7 data-quality panel** → Tasks 5, 12. **§8 search/filter/sort standard** → Task 11. **§9 consistency cleanups** → Tasks 9, 10, 14. **§12 acceptance** → Tasks 6 (invariant), 8 (parity), 11 (guard). **§13 test cases** → distributed across Tasks 1–6, 9.
- **Placeholder scan:** none — every task has files, interfaces, concrete test cases, acceptance.
- **Type consistency:** `FinancialsRow`, `FinancialsResponse`, `KpiSummary`, `DataQualitySummary`, `Channel`, `Measure`, `StatementKind`, `buildFinancials`, `aggregateRows`, `buildTree` used consistently across tasks.
- **Coverage gap check:** Balance-Sheet A/R derivation is out of scope (spec §10) — Task 6 preserves current BS semantics rather than reimplementing; noted, not a gap.

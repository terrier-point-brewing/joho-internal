// Shared types for the consolidated financials view. Every source row (POS,
// invoices, expenses, bank ledger, refunds) normalizes onto FinancialsRow so
// downstream code (P&L, balance sheet, cash flow) never re-derives sign or
// shape per source.

export type StatementKind = "pl" | "balance_sheet" | "cash_flow";
export type Measure = "amount" | "bbl" | "amount_per_bbl";
export type Channel = "taproom" | "events" | "contract_brewing" | "distribution" | "wholesale" | "unknown";
export type BblCoverage = "full" | "partial" | "unknown";
export type MappingSource = "manual" | "rule" | "unmapped";

export interface FinancialsRow {
  coaId: string | null;
  parentId: string | null;
  accountName: string;
  statementSection: string;
  channel: Channel;
  posCategory: string | null;
  kegSize: "half" | "quarter" | "sixth" | "can" | null;
  amountCentsByMonth: Record<string, number>; // sign-normalized cents, key "YYYY-MM"
  bblByMonth: Record<string, number>;
  bblCoverage: BblCoverage;
  mappingSource: MappingSource;
  /**
   * Which table a row's postings came from, and which of its rows.
   *
   * `ids` is server-side provenance and is OPTIONAL because the API strips it
   * before responding -- see toWireResponse. It was 74% of a 295 KB P&L payload
   * (5,732 UUIDs, 3,589 of them on a single row) and nothing in the browser has
   * ever read it. `table` stays: manualAdjustment.ts discriminates on it.
   */
  sourceRef: { table: string; ids?: string[] };
  /**
   * Months ("YYYY-MM") whose figure is a balance an operator stated, used
   * instead of the one this account's source reported.
   *
   * Balance sheet only, and deliberately narrow. It marks the single case on
   * either statement where a figure is not what its named source says: a bank
   * or card balance restated by hand, because the feed missed the month or
   * disagreed with the statement. A hand-typed TRANSACTION never appears here —
   * it composes with the feeds exactly as an expense does, and badging ordinary
   * bookkeeping would train a reader to ignore the badge.
   *
   * Absent on P&L and cash-flow rows, which have no such concept.
   */
  statedMonths?: string[];
}

// KPI health-strip + data-quality/reconciliation summary shapes, built by
// lib/finance/financials/summaries.ts. Percentages are plain numbers in
// "percent" units (e.g. 62.5 means 62.5%). All *Cents fields are integer
// cents. Not every field here is derivable from FinancialsRow[] alone --
// see summaries.ts's header comment for the row-derivable vs
// parameter-supplied split (exciseCoverage.shipmentsMissingExcise,
// cashOnHandCents, and operatingCashCents come from Task 6's DB fetch /
// cash-flow statement mode).
export interface DataQualitySummary {
  unmapped: { count: number; cents: number; href: string };
  uncategorized: { count: number; cents: number; href: string };
  unknownVolume: { count: number; cents: number; href: string };
  exciseCoverage: { shipmentsMissingExcise: number; href: string };
  /** Square taxes collected but not mapped to a liability account -- their collections are silently omitted from the balance sheet. */
  unmappedTaxes: { count: number; cents: number; href: string };
  /** balance_sheet only: balance-sheet accounts with no active balance_sheet_account_sources row (spec §4.5) -- 0 for pl/cash_flow. */
  unsourcedAccounts: { count: number; href: string };
}

export interface KpiSummary {
  netIncomeCents: Record<string, number>;
  grossMarginPct: Record<string, number>;
  revenueCents: Record<string, number>;
  revenueMoMPct: Record<string, number>;
  operatingCashCents: Record<string, number> | null;
  cashOnHandCents: number | null;
  /**
   * cash_flow only, attached by the API route (the builder cannot reach the
   * balances tree -- statement isolation). Average operating cash of the last
   * three ENDED months, signed: negative is a burn. Null everywhere else.
   */
  burnRateCents?: number | null;
  /**
   * cash_flow only: months of cash left at that burn rate. Null when there is
   * no burn -- operating cash flow is non-negative -- or nothing to divide.
   */
  runwayMonths?: number | null;
}

/** Minimal chart_of_accounts reference row -- every account (not just ones with postings of their own), so buildTree (app/finance/financials/buildTree.ts) can nest a leaf under an ancestor that carries no direct transactions, seed a real-but-currently-unused root account as a $0 line, and FinancialsTable can look up a row's GL account number for the optional "Show GL #" toggle. `statementSection` is the same derived value aggregateRows.ts's coaSection() would assign this account if it ever got a posting. */
export interface CoaAccountRef {
  id: string;
  parentId: string | null;
  accountName: string;
  accountNumber: string | null;
  statementSection: string;
}

export interface FinancialsResponse {
  months: string[];
  rows: FinancialsRow[];
  coaAccounts: CoaAccountRef[];
  dataQuality: DataQualitySummary;
  kpis: KpiSummary;
}

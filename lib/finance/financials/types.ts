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
  sourceRef: { table: string; ids: string[] };
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
}

export interface KpiSummary {
  netIncomeCents: Record<string, number>;
  grossMarginPct: Record<string, number>;
  revenueCents: Record<string, number>;
  revenueMoMPct: Record<string, number>;
  operatingCashCents: Record<string, number> | null;
  cashOnHandCents: number | null;
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

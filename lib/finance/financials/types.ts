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

// Placeholder rollup shapes — full definitions land with the report-building
// task that consumes them. Kept minimal so FinancialsResponse type-checks.
export interface DataQualitySummary {
  unmappedCount: number;
  partialBblCoverageCount: number;
  ruleMappedCount: number;
}

export interface KpiSummary {
  revenueCents: number;
  cogsCents: number;
  grossMarginCents: number;
}

export interface FinancialsResponse {
  months: string[];
  rows: FinancialsRow[];
  dataQuality: DataQualitySummary;
  kpis: KpiSummary;
}

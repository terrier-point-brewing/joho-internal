// Orchestrator for the consolidated financials view (spec §1-2). Fetches the
// persisted CoA-mapped source rows (fetchSources.ts), runs the pure
// aggregation (aggregateRows.ts) and KPI/data-quality summaries
// (summaries.ts), applies the per-statement-mode shape, and assembles the
// FinancialsResponse. Reads ONLY persisted tables (no live Square) via
// fetchFinancialsSources, so this whole module is Square-independent.
//
// No business logic lives here beyond wiring + the statement-mode split --
// aggregation/normalization/volume/KPI math all live in Tasks 2-5's modules.

import { fetchFinancialsSources } from "./fetchSources";
import { aggregateRows } from "./aggregateRows";
import { buildKpis, buildDataQuality } from "./summaries";
import type { FinancialsResponse, StatementKind } from "./types";

// Deep links into the Transactions subtabs (app/finance/transactions/{orders,invoices,expenses,bank-ledger}).
// Exact filter-param wiring may be refined by the panel task; these are
// reasonable defaults pointing at the right subtab + intent.
const HREFS = {
  unmapped: "/finance/transactions/orders?mapping=unmapped",
  uncategorized: "/finance/transactions/orders?filter=uncategorized",
  unknownVolume: "/finance/transactions/orders?filter=unknown-volume",
  strandedDeposit: "/finance/transactions/invoices?filter=deposit-missing-delivery",
  exciseCoverage: "/finance/transactions/invoices?filter=excise-coverage",
};

export async function buildFinancials(params: { statement: StatementKind; year: number }): Promise<FinancialsResponse> {
  const { statement, year } = params;

  const src = await fetchFinancialsSources({ statement, year });
  // Defensive cap even though fetchFinancialsSources already caps -- keeps
  // this invariant true regardless of what the fetch layer returns.
  const months = src.months.slice(-12);

  const rows = aggregateRows({
    pos: src.pos,
    invoiceLines: src.invoiceLines,
    expenses: src.expenses,
    refunds: src.refunds,
    bank: src.bank,
    coa: src.coa,
    months,
  });

  // Non-row-derivable KPI pieces (see lib/finance/financials/types.ts):
  // operatingCashCents only makes sense for the cash_flow statement (net
  // income computed over the already cash-filtered rows == direct-method
  // operating cash flow); cashOnHandCents only for balance_sheet (the
  // cumulative bank-section balance in the single Total bucket).
  let operatingCashCents: Record<string, number> | null = null;
  let cashOnHandCents: number | null = null;

  if (statement === "cash_flow") {
    operatingCashCents = buildKpis(rows, months).netIncomeCents;
  } else if (statement === "balance_sheet") {
    const totalMonth = months[months.length - 1];
    cashOnHandCents = rows
      .filter((r) => r.statementSection === "bank")
      .reduce((sum, r) => sum + (r.amountCentsByMonth[totalMonth] ?? 0), 0);
  }

  const kpis = buildKpis(rows, months, { operatingCashCents, cashOnHandCents });
  const dataQuality = buildDataQuality(rows, {
    hrefs: HREFS,
    strandedDeposit: src.strandedDeposit,
    exciseCoverage: src.exciseCoverage,
  });

  return { months, rows, dataQuality, kpis };
}

// Orchestrator for the consolidated financials view (spec §1-2). pl/cash_flow
// fetch the persisted CoA-mapped source rows (fetchSources.ts), run the pure
// aggregation (aggregateRows.ts) and KPI/data-quality summaries
// (summaries.ts), and assemble the FinancialsResponse.
//
// The balance_sheet path lives in ./buildBalanceSheetFinancials.ts and is
// reached only through the dispatcher at the bottom of this file. That split is
// deliberate: the balance sheet is under active development while pl and
// cash_flow are settled and verified, and nothing in this file should need to
// change for balance-sheet work again.
// scripts/check-statement-isolation.mjs enforces it.
//
// Reads ONLY persisted tables (no live Square), so this whole module is
// Square-independent.

import { fetchFinancialsSources } from "./fetchSources";
import { aggregateRows } from "./aggregateRows";
import { buildKpis, buildDataQuality } from "./summaries";
import { injectManualNetSales } from "./manualNetSales";
import { injectDepreciationRows, injectInventoryReliefRows, injectSquareFeeRows } from "./derivedStatementRows";
import { HREFS, coaAccountRefsOf } from "./statementCommon";
import { buildBalanceSheetFinancials } from "./buildBalanceSheetFinancials";
import type { FinancialsResponse, StatementKind } from "./types";

// ── pl / cash_flow ──────────────────────────────────────────────────────────

async function buildFlowFinancials(statement: "pl" | "cash_flow", year: number): Promise<FinancialsResponse> {
  const src = await fetchFinancialsSources({ statement, year });
  // Defensive cap even though fetchFinancialsSources already caps -- keeps
  // this invariant true regardless of what the fetch layer returns.
  const months = src.months.slice(-12);

  let rows = aggregateRows({
    pos: src.pos,
    invoiceLines: src.invoiceLines,
    expenses: src.expenses,
    refunds: src.refunds,
    bank: src.bank,
    // No balance-sheet-only accrual analog on the P&L/cash-flow path.
    tipAccruals: [],
    taxAccruals: [],
    coa: src.coa,
    months,
  });

  rows = injectManualNetSales(rows, src.manualNetSalesEntries, months, src.coa);

  // Depreciation and inventory relief: derived, and NON-CASH, so the fetch
  // layer supplies them for the P&L alone (empty on cash_flow — the cash-flow
  // statement counts the purchases themselves, and injecting either there
  // would misstate operating cash by the adjustment). Retained earnings
  // (balances/providers/retainedEarnings.ts) adds the same two figures
  // cumulatively, through the same modules, so equity absorbs exactly what
  // these rows recognize. `?? []` because older fixtures predate the fields.
  rows = injectDepreciationRows(rows, src.depreciationStates ?? [], months, src.coa);
  rows = injectInventoryReliefRows(rows, src.inventoryValueSeries ?? [], months, src.coa);
  // Square fees arrive for BOTH statements: real cash, withheld at source.
  rows = injectSquareFeeRows(rows, src.squareFeeSeries ?? null, months, src.coa);

  // operatingCashCents only makes sense for the cash_flow statement (net
  // income computed over the already cash-filtered rows == direct-method
  // operating cash flow); cashOnHandCents is a balance_sheet-only figure.
  const operatingCashCents = statement === "cash_flow" ? buildKpis(rows, months).netIncomeCents : null;

  const kpis = buildKpis(rows, months, { operatingCashCents, cashOnHandCents: null });
  const dataQuality = buildDataQuality(rows, {
    hrefs: HREFS,
    exciseCoverage: src.exciseCoverage,
    unmappedTaxes: { count: 0, cents: 0 },
  });

  return { months, rows, coaAccounts: coaAccountRefsOf(src.coa), dataQuality, kpis };
}

// ── entry point ──────────────────────────────────────────────────────────

export async function buildFinancials(params: { statement: StatementKind; year: number }): Promise<FinancialsResponse> {
  const { statement, year } = params;
  if (statement === "balance_sheet") return buildBalanceSheetFinancials(year);
  return buildFlowFinancials(statement, year);
}

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
import { aggregateRows, coaSection } from "./aggregateRows";
import { buildKpis, buildDataQuality } from "./summaries";
import { injectManualNetSales } from "./manualNetSales";
import { ACCOUNT_TYPE_SECTION } from "../accountSections";
import type { FinancialsResponse, FinancialsRow, StatementKind } from "./types";

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

/**
 * BS mode only (C3): ports app/api/finance/statements/route.ts:474-488's
 * open-invoice A/R derivation onto the consolidated FinancialsRow model.
 * openInvoiceArCents (sum of open invoices' total_cents as of the BS period
 * end, computed in fetchSources.ts) is added to the A/R account's existing
 * cumulative balance if invoice lines are already mapped there; otherwise a
 * FinancialsRow is synthesized so the BS doesn't silently under-report A/R
 * for an account with real open-invoice balance but no mapped lines. Guarded
 * on openInvoiceArCents > 0 like the original.
 */
function injectOpenInvoiceAr(
  rows: FinancialsRow[],
  arAccount: { id: string; name: string } | null,
  openInvoiceArCents: number,
  periodMonth: string,
): FinancialsRow[] {
  if (!arAccount || openInvoiceArCents <= 0) return rows;

  const existingIdx = rows.findIndex((r) => r.coaId === arAccount.id);
  if (existingIdx !== -1) {
    const existing = rows[existingIdx];
    const updated: FinancialsRow = {
      ...existing,
      amountCentsByMonth: {
        ...existing.amountCentsByMonth,
        [periodMonth]: (existing.amountCentsByMonth[periodMonth] ?? 0) + openInvoiceArCents,
      },
      sourceRef: { ...existing.sourceRef, ids: [...existing.sourceRef.ids, "open-invoices-ar"] },
    };
    return [...rows.slice(0, existingIdx), updated, ...rows.slice(existingIdx + 1)];
  }

  const synthesized: FinancialsRow = {
    coaId: arAccount.id,
    parentId: null,
    accountName: arAccount.name,
    statementSection: ACCOUNT_TYPE_SECTION["Accounts receivable (A/R)"],
    channel: "unknown",
    posCategory: null,
    kegSize: null,
    amountCentsByMonth: { [periodMonth]: openInvoiceArCents },
    bblByMonth: { [periodMonth]: 0 },
    bblCoverage: "full",
    mappingSource: "rule",
    sourceRef: { table: "invoices", ids: ["open-invoices-ar"] },
  };
  return [...rows, synthesized];
}

export async function buildFinancials(params: { statement: StatementKind; year: number }): Promise<FinancialsResponse> {
  const { statement, year } = params;

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
    coa: src.coa,
    months,
  });

  if (statement === "balance_sheet") {
    rows = injectOpenInvoiceAr(rows, src.arAccount, src.openInvoiceArCents, months[months.length - 1]);
  } else {
    // pl/cash_flow only (Square parity fix B) -- src.manualNetSalesEntries is
    // always [] for balance_sheet anyway (fetchSources.ts), so this branch is
    // belt-and-suspenders explicit about the statement-mode scoping.
    rows = injectManualNetSales(rows, src.manualNetSalesEntries, months);
  }

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

  // Full CoA reference table (not filtered to accounts with postings) --
  // buildTree needs every account's parent_id/name to nest a leaf under a
  // grouping ancestor that carries no direct transactions of its own, and to
  // seed a real-but-currently-unused root account (e.g. "Interest Earned")
  // as a $0 line instead of a whole section reading as empty. `statementSection`
  // reuses aggregateRows.ts's own coaSection() so an unposted account is
  // bucketed identically to how it WOULD be the moment it got a posting.
  // The UI's "Show GL #" toggle needs each account's account_number.
  const coaAccounts = src.coa.map((c) => ({
    id: c.id,
    parentId: c.parentId,
    accountName: c.accountName,
    accountNumber: c.accountNumber,
    statementSection: coaSection(c),
  }));

  return { months, rows, coaAccounts, dataQuality, kpis };
}

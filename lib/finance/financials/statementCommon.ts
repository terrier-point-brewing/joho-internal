// The two pieces genuinely shared by the P&L/cash-flow builder and the
// balance-sheet builder. Extracted so those two can live in separate modules
// without importing each other -- buildFinancials.ts dispatches to
// buildBalanceSheetFinancials.ts, so anything the balance sheet pulled back out
// of buildFinancials.ts would be a cycle.
//
// Keep this file small. It is shared by a statement that is under active
// development and two that are not; anything added here widens the blast radius
// of balance-sheet work back onto the P&L.

import { coaSection } from "./aggregateRows";
import type { CoaRecord } from "./aggregateRows";
import type { CoaAccountRef } from "./types";

// Deep links into the Transactions subtabs (app/finance/transactions/{orders,invoices,expenses,bank-ledger}).
// Exact filter-param wiring may be refined by the panel task; these are
// reasonable defaults pointing at the right subtab + intent.
export const HREFS = {
  // `mapping=open` is "not fully mapped" (mappingStatus.ts): it includes a
  // part-mapped record's stray line and a line accepted as-is, both of which
  // the statement counts as unmapped. `mapping=unmapped` showed neither.
  unmapped: "/finance/transactions/orders?mapping=open",
  // Keyed by FinancialsRow.sourceRef.table -- where a line without an account
  // can actually be given one.
  unmappedPlaces: {
    pos_line_items: { label: "Orders", href: "/finance/transactions/orders?mapping=open" },
    invoice_line_items: { label: "Invoices", href: "/finance/transactions/invoices?mapping=open" },
    // `excluded=active`: an excluded expense stays on the tab but is dropped
    // from the statements, so it is not part of this figure.
    expenses: { label: "Expenses", href: "/finance/transactions/expenses?mapping=open&excluded=active" },
    bank_ledger: { label: "Bank ledger", href: "/finance/transactions/bank-ledger?mapping=open" },
  } as Record<string, { label: string; href: string }>,
  uncategorized: "/finance/transactions/orders?filter=uncategorized",
  unknownVolume: "/finance/transactions/orders?filter=unknown-volume",
  exciseCoverage: "/finance/transactions/invoices?filter=excise-coverage",
  unmappedTaxes: "/settings/finance/gl-mapping?tab=sales-tax",
  unsourcedAccounts: "/settings/finance/balance-sheet-accounts",
};

export function coaAccountRefsOf(coa: CoaRecord[]): CoaAccountRef[] {
  return coa.map((c) => ({
    id: c.id,
    parentId: c.parentId,
    accountName: c.accountName,
    accountNumber: c.accountNumber,
    statementSection: coaSection(c),
  }));
}

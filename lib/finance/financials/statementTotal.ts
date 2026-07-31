// How a statement's right-hand "Total" column is computed.
//
// A P&L or cash-flow row is a FLOW: each month is an amount that happened
// during that month, so the total for the period is their sum.
//
// A balance-sheet row is a STOCK: each month is the balance AS OF that month
// end. Summing them is meaningless -- adding January's cash to February's cash
// double-counts every dollar that sat in the account both months. The period
// figure is the CLOSING balance: the latest month, full stop.
//
// This mattered the moment the balance sheet gained month-over-month columns.
// While it rendered a single synthetic month, "sum of all months" and "the
// latest month" were the same number and the distinction was invisible. With
// twelve columns, summing produces a figure roughly twelve times too large.
//
// Both the rendered cell (FinancialsTable's MeasureTotalCell) and the sort
// accessor (controls.ts's "total" column) must agree, which is why the rule
// lives here rather than being written out twice.

import type { StatementKind } from "./types";

export type TotalMode = "sum" | "closing";

/** `sum` for flow statements (P&L, cash flow); `closing` for the balance sheet. */
export function totalModeFor(statement: StatementKind): TotalMode {
  return statement === "balance_sheet" ? "closing" : "sum";
}

/**
 * The period figure for one row.
 *
 * `months` is assumed chronologically ascending, which is how buildFinancials
 * emits it; `closing` reads the last entry. An empty `months` yields 0 in both
 * modes rather than NaN or undefined.
 */
export function statementTotal(
  byMonth: Record<string, number>,
  months: string[],
  mode: TotalMode,
): number {
  if (mode === "closing") {
    const last = months[months.length - 1];
    return last === undefined ? 0 : (byMonth[last] ?? 0);
  }
  return months.reduce((sum, m) => sum + (byMonth[m] ?? 0), 0);
}

/** Column header for the period figure. A balance sheet's is a balance, not a total. */
export function totalColumnLabel(mode: TotalMode): string {
  return mode === "closing" ? "Balance" : "Total";
}

/**
 * The five credit-side balance-sheet sections, stored NEGATIVE internally and
 * flipped for display (buildTree's toPresentationSign).
 *
 * Lives here so the sort accessor can apply the same flip. It previously could
 * not: useTableControls sorts the flat internal-convention rows while the tree
 * negates afterwards, so sorting the balance sheet by Balance descending put
 * the LARGEST liability last while displaying it as the largest positive
 * number. Unifying sum-vs-closing was not enough -- the cell and the accessor
 * have to agree on sign as well.
 */
export const CREDIT_SIDE_SECTIONS: ReadonlySet<string> = new Set([
  "ap",
  "credit_card",
  "other_current_liabilities",
  "long_term_liabilities",
  "equity",
]);

/** Display value for one row: the period figure, flipped if it sits on the credit side. */
export function presentationTotal(
  byMonth: Record<string, number>,
  months: string[],
  mode: TotalMode,
  statementSection: string,
): number {
  const total = statementTotal(byMonth, months, mode);
  if (mode === "closing" && CREDIT_SIDE_SECTIONS.has(statementSection)) return -total || 0;
  return total;
}

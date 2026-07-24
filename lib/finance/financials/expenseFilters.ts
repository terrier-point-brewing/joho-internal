/**
 * The one place that decides which `expenses` rows are eligible for a financial
 * statement. Both the app's aggregation (fetchSources.fetchExpenses) and the
 * standalone parity script build their own query against `expenses`; when they
 * disagree the parity script reports a false discrepancy, so the filter chain
 * lives here and both call it.
 */

/** The subset of a PostgREST builder these filters need. Structural so both the real client and tests satisfy it. */
export interface ExpenseFilterable {
  ilike(column: string, pattern: string): unknown;
  or(filters: string): unknown;
  is(column: string, value: null): unknown;
}

/**
 * Applies statement eligibility to an `expenses` query:
 *
 * - Cash basis = settled rows only. Card rows settle as "CLEARED" (Square,
 *   uppercase); bank rows -- every Gusto payroll withdrawal among them -- settle
 *   as "cleared" (bankLedger.ts, lowercase). A case-sensitive .eq("CLEARED")
 *   silently dropped every bank/payroll expense (and its GL splits) from the
 *   cash-flow statement, so match case-insensitively via ilike.
 * - Manually excluded rows are duplicates/data artifacts and never belong on ANY
 *   statement -- P&L, cash flow, or balance sheet. This is stricter than
 *   ramp_bank_ledger.affects_pl (which the balance sheet deliberately ignores)
 *   because an excluded expense's real cash movement is carried by another row.
 */
export function applyExpenseStatementFilters<T extends ExpenseFilterable>(q: T, cashOnly: boolean): T {
  const stated = (cashOnly ? q.ilike("state", "cleared") : q.or("state.is.null,state.neq.DECLINED")) as T;
  return stated.is("excluded_at", null) as T;
}

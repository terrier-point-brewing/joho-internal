/**
 * The one place that decides which `expenses` rows are eligible for a financial
 * statement. Both the app's aggregation (fetchSources.fetchExpenses) and the
 * standalone parity script build their own query against `expenses`; when they
 * disagree the parity script reports a false discrepancy, so the filter chain
 * lives here and both call it.
 */

/** The subset of a PostgREST builder these filters need. Structural so both the real client and tests satisfy it. */
export interface ExpenseFilterable {
  or(filters: string): unknown;
  is(column: string, value: null): unknown;
}

/**
 * Applies statement eligibility to an `expenses` query:
 *
 * - Cash basis = rows whose money has actually moved. Two kinds:
 *     * a card swipe or bank debit, state "CLEARED";
 *     * a Ramp bill or reimbursement claim that has been paid, i.e. one with a
 *       `settled_at`. Their state is "PAID" / "REIMBURSED", never "CLEARED",
 *       so matching on CLEARED alone left every bill the business ever paid --
 *       rent, malt, utilities -- off the cash-flow statement in every month.
 *       `settled_at` rather than the state, because state is overwritten on
 *       each sync and `settled_at` is the as-at key (see accruals.ts).
 *   The caller dates a settled row by `settled_at`, not `accounting_date`
 *   (fetchSources.fetchExpenses).
 *
 *   The CLEARED literal is exact and upper-case, safe only because the column
 *   enforces its own casing: the `expenses_state_upper_check` CHECK constraint
 *   (supabase/migrations/20261001090000_expenses_state_uppercase.sql) plus the
 *   upper() at each write site (lib/finance/rampExpenses.ts,
 *   lib/finance/bankLedger.ts). Mixed casing once silently dropped every Gusto
 *   payroll withdrawal from the cash-flow statement. If that constraint is ever
 *   dropped, restore it -- do not paper over it with ilike.
 * - Manually excluded rows are duplicates/data artifacts and never belong on ANY
 *   statement -- P&L, cash flow, or balance sheet. This is stricter than
 *   bank_ledger.affects_pl (which the balance sheet deliberately ignores)
 *   because an excluded expense's real cash movement is carried by another row.
 */
export function applyExpenseStatementFilters<T extends ExpenseFilterable>(q: T, cashOnly: boolean): T {
  const stated = (q.or(cashOnly ? "state.eq.CLEARED,settled_at.not.is.null" : "state.is.null,state.neq.DECLINED")) as T;
  return stated.is("excluded_at", null) as T;
}

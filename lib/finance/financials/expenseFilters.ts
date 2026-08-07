/**
 * The one place that decides which `expenses` rows are eligible for a financial
 * statement. Both the app's aggregation (fetchSources.fetchExpenses) and the
 * standalone parity script build their own query against `expenses`; when they
 * disagree the parity script reports a false discrepancy, so the filter chain
 * lives here and both call it.
 */

/** The subset of a PostgREST builder these filters need. Structural so both the real client and tests satisfy it. */
export interface ExpenseFilterable {
  filter(column: string, operator: string, value: unknown): unknown;
  or(filters: string): unknown;
  is(column: string, value: null): unknown;
}

/**
 * Applies statement eligibility to an `expenses` query:
 *
 * - Cash basis = settled rows only, i.e. state "CLEARED". This line is load-
 *   bearing and was once wrong: `expenses.state` used to hold mixed casing --
 *   card rows settled as "CLEARED" but bank rows, which is every Gusto payroll
 *   withdrawal, settled as lower-case "cleared" -- so a case-SENSITIVE match
 *   silently dropped every bank/payroll expense and its GL splits from the
 *   cash-flow statement. The stopgap was to match with ilike. An exact match is
 *   safe again ONLY because the column now enforces its own casing: see the
 *   `expenses_state_upper_check` CHECK constraint added in
 *   supabase/migrations/20261001090000_expenses_state_uppercase.sql, plus the
 *   upper() at each write site (lib/finance/rampExpenses.ts,
 *   lib/finance/bankLedger.ts). If that constraint is ever dropped this
 *   comparison silently becomes a bug again -- restore the constraint, do not
 *   paper over it with ilike.
 *
 *   Spelled `.filter("state", "eq", ...)` rather than `.eq("state", ...)` purely
 *   for the type-checker: PostgREST's `eq` has a single deeply-conditional
 *   signature (ResolveFilterValue over the selected row) that blows TS's
 *   instantiation depth limit here (TS2589 at
 *   lib/finance/balances/providers/transactionPostings.ts), while `filter` has a
 *   plain non-generic overload. Both emit the identical `state=eq.CLEARED`.
 * - Manually excluded rows are duplicates/data artifacts and never belong on ANY
 *   statement -- P&L, cash flow, or balance sheet. This is stricter than
 *   ramp_bank_ledger.affects_pl (which the balance sheet deliberately ignores)
 *   because an excluded expense's real cash movement is carried by another row.
 */
export function applyExpenseStatementFilters<T extends ExpenseFilterable>(q: T, cashOnly: boolean): T {
  const stated = (cashOnly ? q.filter("state", "eq", "CLEARED") : q.or("state.is.null,state.neq.DECLINED")) as T;
  return stated.is("excluded_at", null) as T;
}

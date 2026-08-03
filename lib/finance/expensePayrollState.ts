/**
 * Per-expense payroll-match state: which pay period an expense is matched to,
 * that period's date range (for labeling the pill), whether an active Gusto GL
 * report exists yet, and the expense's resolved GL line(s).
 *
 * The GET /api/finance/expenses list builds this same shape in a batched query
 * for the whole page; this single-expense builder lets the payroll-match
 * mutation route return fresh state for just the affected row, so the client
 * can patch that one row instead of reloading the entire ledger.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getExpenseGlLines, type ExpenseGlLine } from "./expenseGlLines";

export interface PayrollMatchState {
  payPeriodId: string;
  periodStart: string; // YYYY-MM-DD
  periodEnd: string;   // YYYY-MM-DD
  hasReport: boolean;  // an un-superseded Gusto GL report exists for the period
  /** Which of Gusto's two ACH pulls this charge is. Null when a human matched
   *  it by hand, or when it predates amount matching — both mean nobody has
   *  established WHICH debit it is, only that it belongs to the period. */
  matchedComponent: "net_pay" | "taxes" | null;
}

export interface ExpensePayrollState {
  payrollMatch: PayrollMatchState | null;
  glLines: ExpenseGlLine[];
}

/** Builds the payroll-match + GL-line state for a single expense (mirrors the GET list shape). */
export async function getExpensePayrollState(
  sb: SupabaseClient,
  expenseId: string,
): Promise<ExpensePayrollState> {
  const { data: matchRow, error: matchErr } = await sb
    .from("payroll_period_expense_matches")
    .select("pay_period_id, matched_component")
    .eq("expense_id", expenseId)
    .maybeSingle();
  if (matchErr) throw new Error(`Load payroll match failed: ${matchErr.message}`);

  const glLines = await getExpenseGlLines(sb, expenseId);
  const match = matchRow as { pay_period_id: string; matched_component: string | null } | null;
  const payPeriodId = match?.pay_period_id ?? null;
  const matchedComponent =
    match?.matched_component === "net_pay" || match?.matched_component === "taxes" ? match.matched_component : null;
  if (!payPeriodId) return { payrollMatch: null, glLines };

  const [{ data: period, error: periodErr }, { data: report, error: reportErr }] = await Promise.all([
    sb.from("pay_periods").select("start_date, end_date").eq("id", payPeriodId).single(),
    sb
      .from("payroll_gl_reports")
      .select("pay_period_id")
      .eq("pay_period_id", payPeriodId)
      .is("superseded_at", null)
      .maybeSingle(),
  ]);
  if (periodErr) throw new Error(`Load pay period failed: ${periodErr.message}`);
  if (reportErr) throw new Error(`Load payroll GL report failed: ${reportErr.message}`);

  const periodRow = period as { start_date: string; end_date: string } | null;
  return {
    payrollMatch: {
      payPeriodId,
      periodStart: periodRow?.start_date ?? "",
      periodEnd: periodRow?.end_date ?? "",
      hasReport: report != null,
      matchedComponent,
    },
    glLines,
  };
}

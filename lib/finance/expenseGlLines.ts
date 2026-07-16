/**
 * Resolves an expense's effective GL line(s): either its split rows
 * (expense_gl_splits, from payroll matching or a manual override) or a
 * single synthesized line from the expense's own resolved account/amount.
 * Pure resolution logic here; DB IO isolated in getExpenseGlLines so the
 * batch-fetch path (Financials aggregation, Task 7) and single-expense
 * callers can both depend on the same pure core.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface ExpenseGlLine {
  chartOfAccountsId: string;
  amountCents: number;
  splitSource: "payroll_auto" | "manual" | null; // null when synthesized (no split rows exist)
}

/**
 * Returns expense_gl_splits rows for expenseId if any exist; otherwise a
 * single synthesized line from the expense's own account/amount (or [] if
 * the expense has no chart_of_accounts_id at all — unmapped).
 */
export function resolveExpenseGlLines(
  splitRows: { chartOfAccountsId: string; amountCents: number; splitSource: "payroll_auto" | "manual" }[],
  fallback: { chartOfAccountsId: string | null; amountCents: number },
): ExpenseGlLine[] {
  if (splitRows.length > 0) return splitRows;
  if (!fallback.chartOfAccountsId) return [];
  return [{ chartOfAccountsId: fallback.chartOfAccountsId, amountCents: fallback.amountCents, splitSource: null }];
}

/** DB-fetching wrapper: queries expense_gl_splits for expenseId, then delegates to resolveExpenseGlLines. */
export async function getExpenseGlLines(sb: SupabaseClient, expenseId: string): Promise<ExpenseGlLine[]> {
  const { data: splitRows, error: splitErr } = await sb
    .from("expense_gl_splits")
    .select("chart_of_accounts_id, amount_cents, split_source")
    .eq("expense_id", expenseId);
  if (splitErr) throw new Error(`Load expense GL splits failed: ${splitErr.message}`);

  const splits = (splitRows ?? []).map((r) => ({
    chartOfAccountsId: r.chart_of_accounts_id as string,
    amountCents: r.amount_cents as number,
    splitSource: r.split_source as "payroll_auto" | "manual",
  }));

  // Only need the expense's own fallback account/amount when there's no split.
  if (splits.length > 0) return resolveExpenseGlLines(splits, { chartOfAccountsId: null, amountCents: 0 });

  const { data: expense, error: expErr } = await sb
    .from("expenses")
    .select("chart_of_accounts_id, amount_cents")
    .eq("id", expenseId)
    .single();
  if (expErr) throw new Error(`Load expense failed: ${expErr.message}`);

  return resolveExpenseGlLines(splits, {
    chartOfAccountsId: expense?.chart_of_accounts_id ?? null,
    amountCents: expense?.amount_cents ?? 0,
  });
}

/**
 * Setting one expense aside as a duplicate, with the checks that make it safe.
 *
 * An excluded row is dropped from every financial statement (see
 * financials/expenseFilters.ts) but stays visible and reversible in the
 * Transactions ledger. Shared by the Expenses grid's own exclude action and the
 * duplicate review, so the two cannot disagree about what blocks an exclusion.
 */
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

export type ExcludeExpenseResult =
  | { ok: true; row: { id: string; excluded_at: string | null; excluded_reason: string | null } }
  | { ok: false; status: 409 | 500; error: string };

export async function excludeExpense(
  sb: AdminClient,
  input: { id: string; reason: string; userId: string | null },
): Promise<ExcludeExpenseResult> {
  const { id, reason, userId } = input;

  // A manually split expense codes through its split lines; excluding it would
  // strand them. Make the operator clear the split first rather than silently
  // winning. Scoped to split_source='manual': payroll_auto rows are owned by the
  // pay-period recompute and cannot be cleared from this UI, so treating them as
  // a blocker would tell the operator to do something they have no way to do.
  const { data: splits, error: splitErr } = await sb
    .from("expense_gl_splits").select("id").eq("expense_id", id).eq("split_source", "manual").limit(1);
  if (splitErr) return { ok: false, status: 500, error: splitErr.message };
  if (splits && splits.length > 0) {
    return { ok: false, status: 409, error: "Clear this transaction's manual GL split before excluding it" };
  }

  // A payroll-matched expense stays in its pay period's totals either way:
  // lib/payroll/periodSummary.ts sums expenses.amount_cents for matched ids and
  // has no exclusion filter. Excluding here would drop the row from every
  // statement while payroll still reports it as matched and reconciled, so the
  // two modules would disagree about the same money. Unmatch first.
  const { data: matches, error: matchErr } = await sb
    .from("payroll_period_expense_matches").select("id").eq("expense_id", id).limit(1);
  if (matchErr) return { ok: false, status: 500, error: matchErr.message };
  if ((matches ?? []).length > 0) {
    return { ok: false, status: 409, error: "Unmatch this transaction from its pay period before excluding it" };
  }

  const { data, error } = await sb
    .from("expenses")
    .update({ excluded_at: new Date().toISOString(), excluded_reason: reason, excluded_by: userId })
    .eq("id", id)
    .select("id, excluded_at, excluded_reason")
    .single();
  if (error) return { ok: false, status: 500, error: error.message };

  return { ok: true, row: data as { id: string; excluded_at: string | null; excluded_reason: string | null } };
}

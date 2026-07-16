/**
 * Payroll period matching actions for a single expense row. Expenses whose
 * counterparty mapping is routed 'payroll_split' (see
 * lib/finance/expenses.ts's resolveExpenseMapping payroll_split skip) surface
 * unmapped in the normal Transactions flow and are matched to a pay period
 * here instead. Body:
 *   { action: "suggest" }
 *   { action: "match"; payPeriodId: string }
 *   { action: "unmatch" }
 *   { action: "recompute"; confirmOverwriteManual?: boolean }
 * All actions gate manager+, use the service-role admin client, and delegate
 * all proportional-split/manual-skip math to
 * lib/finance/payrollMatching.ts's suggestPayPeriod/recomputePeriodExpenseSplits
 * -- this route is thin orchestration only.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { suggestPayPeriod, recomputePeriodExpenseSplits } from "@/lib/finance/payrollMatching";
import { getExpensePayrollState } from "@/lib/finance/expensePayrollState";

export const dynamic = "force-dynamic";

type PayrollMatchAction =
  | { action: "suggest" }
  | { action: "match"; payPeriodId: string }
  | { action: "unmatch" }
  | { action: "recompute"; confirmOverwriteManual?: boolean };

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requireRole(["manager"]); } catch (res) { return res as Response; }

  const { id } = await params;

  try {
    const body = (await req.json()) as PayrollMatchAction;
    const sb = createSupabaseAdminClient();

    switch (body.action) {
      case "suggest": {
        const { data: expense, error: expErr } = await sb
          .from("expenses")
          .select("accounting_date, transaction_time")
          .eq("id", id)
          .single();
        if (expErr) throw new Error(expErr.message);

        const expenseRow = expense as { accounting_date: string | null; transaction_time: string | null } | null;
        const expenseDate = expenseRow?.accounting_date ?? expenseRow?.transaction_time?.slice(0, 10) ?? null;
        if (!expenseDate) return NextResponse.json({ suggestedPeriodId: null });

        // Exclude any period this same expense is already matched to.
        const { data: ownMatches, error: ownErr } = await sb
          .from("payroll_period_expense_matches")
          .select("pay_period_id")
          .eq("expense_id", id);
        if (ownErr) throw new Error(ownErr.message);
        const excluded = new Set(
          ((ownMatches ?? []) as { pay_period_id: string }[]).map((r) => r.pay_period_id),
        );

        const { data: periods, error: periodsErr } = await sb.from("pay_periods").select("id, end_date");
        if (periodsErr) throw new Error(periodsErr.message);

        const candidatePeriods = ((periods ?? []) as { id: string; end_date: string }[])
          .filter((p) => !excluded.has(p.id))
          .map((p) => ({ id: p.id, endDate: p.end_date }));

        const suggestedPeriodId = suggestPayPeriod({ expenseDate, candidatePeriods });
        return NextResponse.json({ suggestedPeriodId });
      }

      case "match": {
        const session = await getSessionUser();
        const { error: insertErr } = await sb.from("payroll_period_expense_matches").insert({
          pay_period_id: body.payPeriodId,
          expense_id: id,
          matched_by: session!.user.id,
        });
        if (insertErr) throw new Error(insertErr.message);

        // Recompute the whole period, not just this expense -- matching a
        // new expense changes every other matched expense's proportional weight.
        await recomputePeriodExpenseSplits(sb, body.payPeriodId);
        // Return this expense's fresh payroll state so the client can patch the
        // single row instead of reloading the whole ledger.
        return NextResponse.json(await getExpensePayrollState(sb, id), { status: 201 });
      }

      case "unmatch": {
        const { data: existing, error: findErr } = await sb
          .from("payroll_period_expense_matches")
          .select("pay_period_id")
          .eq("expense_id", id)
          .maybeSingle();
        if (findErr) throw new Error(findErr.message);
        const match = existing as { pay_period_id: string } | null;
        if (!match) return apiError("Expense is not matched to a pay period", 404);

        const { error: delMatchErr } = await sb
          .from("payroll_period_expense_matches")
          .delete()
          .eq("expense_id", id);
        if (delMatchErr) throw new Error(delMatchErr.message);

        const { error: delSplitsErr } = await sb
          .from("expense_gl_splits")
          .delete()
          .eq("expense_id", id)
          .eq("split_source", "payroll_auto");
        if (delSplitsErr) throw new Error(delSplitsErr.message);

        // Rebalance the remaining matched expenses' proportional weights.
        await recomputePeriodExpenseSplits(sb, match.pay_period_id);
        return NextResponse.json(await getExpensePayrollState(sb, id));
      }

      case "recompute": {
        const { data: splits, error: splitsErr } = await sb
          .from("expense_gl_splits")
          .select("split_source")
          .eq("expense_id", id);
        if (splitsErr) throw new Error(splitsErr.message);
        const hasManual = ((splits ?? []) as { split_source: string }[]).some((r) => r.split_source === "manual");
        if (hasManual && body.confirmOverwriteManual !== true) {
          return apiError("manual_override_exists", 409);
        }

        const { data: existing, error: matchErr } = await sb
          .from("payroll_period_expense_matches")
          .select("pay_period_id")
          .eq("expense_id", id)
          .maybeSingle();
        if (matchErr) throw new Error(matchErr.message);
        const match = existing as { pay_period_id: string } | null;
        if (!match) return apiError("Expense is not matched to a pay period", 404);

        await recomputePeriodExpenseSplits(sb, match.pay_period_id);
        return NextResponse.json(await getExpensePayrollState(sb, id));
      }

      default:
        return apiError("Unknown action", 400);
    }
  } catch (err) {
    return apiError(err);
  }
}

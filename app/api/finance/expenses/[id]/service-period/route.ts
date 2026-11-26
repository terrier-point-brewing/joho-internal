/**
 * The months one expense pays for: set them, or clear them.
 *
 * A row in expense_service_periods makes every accrual statement recognise the
 * expense an equal share per month covered instead of all at once, with the
 * unrecognised part carried as a prepaid expense (lib/finance/servicePeriod.ts).
 * Nothing is ever recognised before the bill's own month, so the only months
 * this can change are the bill's month and those after it — which is why the
 * closed-period check below looks at the bill's month and nothing earlier.
 *
 * Manager+ only, service-role client.
 */
import { NextResponse, type NextRequest } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { validateServicePeriod } from "@/lib/finance/servicePeriod";
import { closedPeriodRefusal } from "@/lib/finance/balances/periodClose";

export const dynamic = "force-dynamic";

type SbClient = ReturnType<typeof createSupabaseAdminClient>;

/**
 * The expense, if its coding may be re-timed, or the response that says why not.
 *
 * Closed month: spreading a bill moves cost out of the month it is dated in, and
 * a closed month's figures no longer change.
 */
async function editableExpense(sb: SbClient, id: string): Promise<{ accountingDate: string } | Response> {
  const { data: expense, error } = await sb
    .from("expenses").select("id, accounting_date, excluded_at").eq("id", id).maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!expense) return NextResponse.json({ error: "Expense not found" }, { status: 404 });
  if (expense.excluded_at) {
    return NextResponse.json({ error: "Restore this transaction before spreading it" }, { status: 409 });
  }
  const accountingDate = expense.accounting_date as string | null;
  if (!accountingDate) return NextResponse.json({ error: "This expense has no date to spread from" }, { status: 409 });

  const refusal = await closedPeriodRefusal(sb, accountingDate);
  if (refusal) return NextResponse.json({ error: refusal }, { status: 409 });
  return { accountingDate };
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let userId: string | null = null;
  try {
    userId = (await requirePermission(CAP.financeTransactionsManage)).user.id;
  } catch (res) { return res as Response; }

  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { start_date?: unknown; end_date?: unknown };
  const validation = validateServicePeriod({ start: body.start_date, end: body.end_date });
  if (!validation.ok) return NextResponse.json({ error: validation.error }, { status: 400 });

  const sb = createSupabaseAdminClient();
  const editable = await editableExpense(sb, id);
  if (editable instanceof Response) return editable;

  // A payroll-matched expense is already attributed to its pay period's months
  // (aggregateRows prorates it there). Two month-attribution rules on one
  // expense would leave it to code order which one wins.
  const { data: matches, error: matchErr } = await sb
    .from("payroll_period_expense_matches").select("expense_id").eq("expense_id", id).limit(1);
  if (matchErr) return NextResponse.json({ error: matchErr.message }, { status: 500 });
  if ((matches ?? []).length > 0) {
    return NextResponse.json(
      { error: "This expense is already spread over its pay period; unmatch it first" },
      { status: 409 },
    );
  }

  const { error: upsertErr } = await sb.from("expense_service_periods").upsert(
    { expense_id: id, start_date: body.start_date as string, end_date: body.end_date as string, updated_by: userId },
    { onConflict: "expense_id" },
  );
  if (upsertErr) return NextResponse.json({ error: upsertErr.message }, { status: 500 });

  return NextResponse.json({ servicePeriod: { start: body.start_date, end: body.end_date } });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }

  const { id } = await params;
  const sb = createSupabaseAdminClient();
  const editable = await editableExpense(sb, id);
  if (editable instanceof Response) return editable;

  const { error } = await sb.from("expense_service_periods").delete().eq("expense_id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ servicePeriod: null });
}

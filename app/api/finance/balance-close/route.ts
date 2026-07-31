/**
 * GET /api/finance/balance-close?periodEnd=YYYY-MM-DD
 *   The period's balance_close_tasks and whether the period is fully closed.
 *
 * Admin client, not the server client: balance_close_tasks' RLS is
 * lock-down-only (see 20260905100000_balance_sheet_snapshots.sql), so a
 * session-scoped client would silently see zero rows. Authorization is
 * enforced here via requirePermission, same as balance-sources.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { unfreezePeriod } from "@/lib/finance/balances/snapshot";
import { monthEnd } from "@/lib/finance/manualEntries";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { listTasksForPeriod, isPeriodClosed } from "@/lib/finance/balances/closeTasks";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try { await requirePermission(CAP.financeStatementsRead); } catch (res) { return res as Response; }

  try {
    const periodEnd = req.nextUrl.searchParams.get("periodEnd");
    if (!periodEnd) {
      return NextResponse.json({ error: "periodEnd is required" }, { status: 400 });
    }

    const supabase = createSupabaseAdminClient();
    const tasks = await listTasksForPeriod(supabase, periodEnd);

    return NextResponse.json({ periodEnd, tasks, closed: isPeriodClosed(tasks) });
  } catch (err) {
    return apiError(err);
  }
}

/**
 * Reopen a frozen period so its balances recompute on the next snapshot run.
 *
 * The cron freezes unconditionally once the due date passes, whether or not the
 * period's tasks were ever fulfilled. Without a reachable inverse, a late Ramp
 * bill or a corrected invoice for a closed month is unrepresentable except by
 * direct database access — and a period frozen in error stays wrong forever,
 * since resolveSnapshotWrites skips frozen rows on every subsequent pass.
 * `unfreezePeriod` existed but had no caller; this is that caller.
 *
 * Gated on financeTransactionsManage rather than the route's read capability:
 * reopening a closed accounting period is a write, not a view.
 */
export async function POST(req: NextRequest) {
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }

  try {
    const body = (await req.json()) as { periodEnd?: string; action?: string };
    if (body.action !== "unfreeze") {
      return NextResponse.json({ error: 'action must be "unfreeze"' }, { status: 400 });
    }
    if (!body.periodEnd || body.periodEnd !== monthEnd(body.periodEnd)) {
      return NextResponse.json(
        { error: "periodEnd is required and must be a month end" },
        { status: 400 },
      );
    }
    await unfreezePeriod(createSupabaseAdminClient(), body.periodEnd);
    return NextResponse.json({ ok: true, periodEnd: body.periodEnd });
  } catch (err) {
    return apiError(err);
  }
}

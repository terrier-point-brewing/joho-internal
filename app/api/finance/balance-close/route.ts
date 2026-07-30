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

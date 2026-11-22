/**
 * GET /api/finance/balance-close/periods
 *   Every ended month nobody has closed, oldest first.
 *
 * The periods index and the Financials banner each used to pick their own
 * months (the last six; the prior one), so a month left open long enough
 * dropped out of both. A close has no deadline, so "which months are waiting"
 * has to come from the close record rather than from the calendar.
 */
import { NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { listOpenPeriodEnds } from "@/lib/finance/balances/openPeriods";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { todayLocalDate } from "@/lib/utils/datetime";

export const dynamic = "force-dynamic";

export async function GET() {
  try { await requirePermission(CAP.financeStatementsRead); } catch (res) { return res as Response; }

  try {
    const supabase = createSupabaseAdminClient();
    return NextResponse.json({ open: await listOpenPeriodEnds(supabase, todayLocalDate()) });
  } catch (err) {
    return apiError(err);
  }
}

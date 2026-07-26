/**
 * POST /api/finance/expenses/auto-map-payroll?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Bulk-match every unmatched payroll_split-routed bank expense in range to its
 * nearest pay period and (re)generate its proportional GL splits. Logic lives
 * in lib/finance/payrollMatching's autoMapPayrollExpenses. Returns
 * { matched, periodsRecomputed }. Manager+ (same gate as the per-row action).
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { autoMapPayrollExpenses } from "@/lib/finance/payrollMatching";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }

  const from = req.nextUrl.searchParams.get("from");
  const to   = req.nextUrl.searchParams.get("to");
  if (!from || !to) return NextResponse.json({ error: "from and to required" }, { status: 400 });

  const session = await getSessionUser();
  const supabase = createSupabaseAdminClient();
  try {
    const result = await autoMapPayrollExpenses(supabase, { from, to, matchedBy: session!.user.id });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "auto-map payroll failed" }, { status: 500 });
  }
}

/**
 * On-demand regeneration of 'payroll_auto' expense_gl_splits rows for every
 * expense matched to a pay period -- thin wrapper over
 * lib/finance/payrollMatching.ts's recomputePeriodExpenseSplits. Called by
 * the payroll-match "match"/"unmatch"/"recompute" actions internally, and by
 * the Gusto Upload UI right after a re-upload changes a period's GL totals
 * (a re-upload alone doesn't recompute already-matched expenses -- see
 * lib/payroll/gustoUpload.ts's doc comment).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { recomputePeriodExpenseSplits } from "@/lib/finance/payrollMatching";

export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ periodId: string }> }) {
  try { await requireRole(["manager"]); } catch (res) { return res as Response; }

  const { periodId } = await params;
  try {
    const sb = createSupabaseAdminClient();
    await recomputePeriodExpenseSplits(sb, periodId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}

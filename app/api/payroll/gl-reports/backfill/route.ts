/**
 * Backfill tool for pre-tips payroll_gl_report_totals rows -- thin wrapper
 * over lib/payroll/glBackfill.ts's backfillGlReports. `dryRun` defaults to
 * `true` here (not just in the lib) so a caller who omits the body field
 * can never mutate anything. This route writes the tool; it does NOT run it
 * against prod -- see the implementation plan for the human-gated rollout
 * (backup, then dryRun: true review, then dryRun: false).
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { backfillGlReports } from "@/lib/payroll/glBackfill";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try { await requirePermission(CAP.payrollOperate); } catch (res) { return res as Response; }

  try {
    let body: { dryRun?: boolean } = {};
    try {
      body = await req.json();
    } catch {
      // No/empty body -- fall through to the dryRun: true default below.
    }
    const dryRun = body.dryRun ?? true;

    const sb = createSupabaseAdminClient();
    const results = await backfillGlReports(sb, { dryRun });

    return NextResponse.json({ dryRun, results });
  } catch (err) {
    return apiError(err);
  }
}

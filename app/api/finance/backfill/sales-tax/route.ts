/**
 * Backfill for the sales-tax-as-revenue correction -- thin wrapper over
 * lib/finance/backfillSalesTax.ts. `dryRun` defaults to `true` HERE (not only
 * in the lib) so a caller who omits the body field can never mutate anything.
 *
 * This route ships the tool; it does NOT run it against prod. See the spec's
 * deployment sequence for the human-gated rollout (backup, dryRun review,
 * then dryRun: false).
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { backfillSalesTax } from "@/lib/finance/backfillSalesTax";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }

  try {
    let body: { dryRun?: boolean } = {};
    try {
      body = await req.json();
    } catch {
      // No/empty body -- fall through to the dryRun: true default below.
    }
    const dryRun = body.dryRun ?? true;

    const report = await backfillSalesTax(createSupabaseAdminClient(), { dryRun });
    return NextResponse.json(report);
  } catch (err) {
    return apiError(err);
  }
}

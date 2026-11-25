// GET /api/finance/forecast/snapshots
//
// Past base-case forecasts, for the Financials page's accuracy panel to set
// against what each month actually came to. Read-only: the rows are written by
// the forecast-snapshot scheduled job.
import { NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { apiError } from "@/lib/utils/api";
import { listForecastSnapshots } from "@/lib/finance/forecast/snapshots.server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET() {
  try { await requirePermission(CAP.financeStatementsRead); } catch (res) { return res as Response; }

  try {
    return NextResponse.json(await listForecastSnapshots(createSupabaseAdminClient()));
  } catch (err) {
    return apiError(err);
  }
}

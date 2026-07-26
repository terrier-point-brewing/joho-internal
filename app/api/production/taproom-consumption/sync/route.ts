import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { runTaproomConsumptionSync } from "@/lib/production/taproomConsumptionSync";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

// POST /api/production/taproom-consumption/sync?days=N
// Reconciles taproom pours (keg/can sales + draft keg-swaps) from Square into
// taproom-channel export shipments that drain cold storage. Idempotent — records
// only the unrecorded delta per source_ref. `days` widens the reconciliation
// window for backfills (default 2, matching the daily cron).
export async function POST(req: NextRequest) {
  try { await requirePermission(CAP.brewingOperate); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const daysRaw = new URL(req.url).searchParams.get("days");
  const days = Math.min(Math.max(parseInt(daysRaw ?? "2", 10) || 2, 1), 120);

  try {
    const result = await runTaproomConsumptionSync(supabase, { days });
    return NextResponse.json(result);
  } catch (err) {
    return apiError(err);
  }
}

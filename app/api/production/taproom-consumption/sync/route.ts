import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { runTaproomConsumptionSync } from "@/lib/production/taproomConsumptionSync";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

// POST /api/production/taproom-consumption/sync?days=N
// Reconciles taproom pours (keg/can sales + draft keg-swaps) from Square into
// taproom-channel export shipments that drain cold storage. Idempotent — records
// only the unrecorded delta per source_ref. `days` widens the reconciliation
// window for backfills (default 2, matching the daily cron).
//
// Runs the sync on the ADMIN client, after `requirePermission` has decided the
// caller may. The sync takes an advisory lease through try_acquire_sync_lock /
// release_sync_lock, and both are granted to `service_role` only — so on the
// signed-in user's client this route answered "permission denied for function
// try_acquire_sync_lock" and did nothing, for every user, however privileged.
// That is the same shape as /api/finance/sync-catalog and the cron route:
// authorise the person, then do the privileged work as the service.
//
// It mattered more than a broken button. This route is the ONLY way to reach
// back further than the daily job's 2-day window, so while it was failing there
// was no way to recover a sale that had missed its moment — 53 keg and can units
// sold between 1 July and 1 August were never booked.
export async function POST(req: NextRequest) {
  try { await requirePermission(CAP.brewingOperate); } catch (res) { return res as Response; }

  const supabase = createSupabaseAdminClient();
  const daysRaw = new URL(req.url).searchParams.get("days");
  const days = Math.min(Math.max(parseInt(daysRaw ?? "2", 10) || 2, 1), 120);

  try {
    const result = await runTaproomConsumptionSync(supabase, { days });
    return NextResponse.json(result);
  } catch (err) {
    return apiError(err);
  }
}

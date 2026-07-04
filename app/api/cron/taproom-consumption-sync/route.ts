/**
 * Daily cron: reconcile taproom consumption (keg/can sales + draft keg-swaps)
 * from Square into taproom-channel export shipments that drain cold storage.
 *
 * Idempotent — re-derives a trailing window and records only the unrecorded
 * delta per source_ref, so overlapping runs never double-count. The run summary
 * (recorded lines + discrepancies) lands in cron_runs.detail for the Settings →
 * Cron Jobs monitor. Older gaps are backfilled via the on-demand sync route's
 * `?days=N` on the Export Bay.
 */
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { runCronJob } from "@/lib/cron/runCronJob";
import { runTaproomConsumptionSync } from "@/lib/production/taproomConsumptionSync";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

const WINDOW_DAYS = 2;

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const outcome = await runCronJob("taproom-consumption-sync", async () => {
    const supabase = createSupabaseAdminClient();
    return await runTaproomConsumptionSync(supabase, { days: WINDOW_DAYS });
  });

  return outcome.ok ? NextResponse.json(outcome.detail) : apiError(outcome.error);
}

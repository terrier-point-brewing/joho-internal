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
import { fetchUnemailedPhantomAlerts, markPhantomAlertsEmailed } from "@/lib/production/phantomExportAlerts";
import { renderPhantomAlertEmail } from "@/lib/production/phantomAlertEmail";
import { sendEmail, ADMIN_EMAIL } from "@/lib/resend";
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
    const result = await runTaproomConsumptionSync(supabase, { days: WINDOW_DAYS });

    // Best-effort daily digest of open phantom-export alerts (draft swaps that
    // booked excise with no cold-storage stock). Email failure must not fail the
    // sync — it is caught and surfaced in the cron detail, never rethrown.
    let phantomDigest: { emailed: number } | { error: string };
    try {
      const alerts = await fetchUnemailedPhantomAlerts(supabase);
      if (alerts.length > 0) {
        const { subject, html } = renderPhantomAlertEmail(alerts);
        await sendEmail(ADMIN_EMAIL, subject, html);
        await markPhantomAlertsEmailed(supabase, alerts.map((a) => a.exportTransactionId));
      }
      phantomDigest = { emailed: alerts.length };
    } catch (err) {
      phantomDigest = { error: err instanceof Error ? err.message : String(err) };
    }

    return { ...result, phantomDigest };
  });

  return outcome.ok ? NextResponse.json(outcome.detail) : apiError(outcome.error);
}

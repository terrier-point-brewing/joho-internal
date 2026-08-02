/**
 * Daily cron: keep imported expenses current without anyone clicking "Sync Ramp".
 *
 * Re-syncs a trailing window (idempotent upsert) so recently-posted transactions
 * land and state changes (e.g. PENDING → CLEARED, which the Cash Flow view cares
 * about) get picked up. Older history is backfilled via the on-demand full-year
 * sync on the Expenses tab.
 *
 * The outcome is also reported against the Ramp connection, so Settings >
 * Balance Sheet Accounts can say that a stale figure is caused by a failing
 * sync. That row previously only ever heard from the balance read, which meant
 * Ramp could show as healthy while the feed underneath it had been broken for a
 * week -- visible on Settings > Cron Jobs, and nowhere near the number it was
 * affecting.
 */
import { NextRequest, NextResponse } from "next/server";
import { syncAllRamp } from "@/lib/finance/rampSync";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { runCronJob } from "@/lib/cron/runCronJob";
import { recordProviderSyncResult } from "@/lib/finance/balances/connections";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

const LOOKBACK_DAYS = 45;

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const to   = new Date();
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - LOOKBACK_DAYS);
  const fromStr = from.toISOString().slice(0, 10);
  const toStr   = to.toISOString().slice(0, 10);

  const outcome = await runCronJob("ramp-expenses-sync", async () => {
    const supabase = createSupabaseAdminClient();
    try {
      const result = await syncAllRamp(supabase, fromStr, toStr);
      const connectionsReported = await recordProviderSyncResult(supabase, "ramp", { ok: true });
      return { ...result, window: { from: fromStr, to: toStr }, connectionsReported };
    } catch (err) {
      // Recorded and then rethrown: the connection needs to say what went
      // wrong, and cron_runs still needs the run marked failed.
      const message = err instanceof Error ? err.message : String(err);
      await recordProviderSyncResult(supabase, "ramp", { ok: false, error: `Nightly Ramp expense sync failed: ${message}` });
      throw err;
    }
  });

  return outcome.ok ? NextResponse.json(outcome.detail) : apiError(outcome.error);
}

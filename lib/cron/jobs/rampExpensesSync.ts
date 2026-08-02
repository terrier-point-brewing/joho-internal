/**
 * Keeps imported expenses current without anyone clicking "Sync Ramp".
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
 *
 * Reported from HERE rather than from the route, so a "Run now" tells the
 * connection the same thing the schedule does. A manual run that left the
 * health line untouched would be the same gap in a smaller window.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { syncAllRamp } from "@/lib/finance/rampSync";
import { recordProviderSyncResult } from "@/lib/finance/balances/connections";

const LOOKBACK_DAYS = 45;

export async function runRampExpensesSync(supabase: SupabaseClient) {
  // Computed at run time rather than passed in, so a manual run covers the same
  // trailing window as the scheduled one and its result means the same thing.
  const to   = new Date();
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - LOOKBACK_DAYS);
  const fromStr = from.toISOString().slice(0, 10);
  const toStr   = to.toISOString().slice(0, 10);

  try {
    const result = await syncAllRamp(supabase, fromStr, toStr);
    const connectionsReported = await recordProviderSyncResult(supabase, "ramp", { ok: true });
    return { ...result, window: { from: fromStr, to: toStr }, connectionsReported };
  } catch (err) {
    // Recorded and then rethrown: the connection needs to say what went wrong,
    // and the run still needs to be marked failed.
    const message = err instanceof Error ? err.message : String(err);
    await recordProviderSyncResult(supabase, "ramp", { ok: false, error: `Ramp expense sync failed: ${message}` });
    throw err;
  }
}

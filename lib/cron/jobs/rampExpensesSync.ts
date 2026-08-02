/**
 * Keeps imported expenses current without anyone clicking "Sync Ramp".
 *
 * Re-syncs a trailing window (idempotent upsert) so recently-posted transactions
 * land and state changes (e.g. PENDING → CLEARED, which the Cash Flow view cares
 * about) get picked up. Older history is backfilled via the on-demand full-year
 * sync on the Expenses tab.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { syncAllRamp } from "@/lib/finance/rampSync";

const LOOKBACK_DAYS = 45;

export async function runRampExpensesSync(supabase: SupabaseClient) {
  // Computed at run time rather than passed in, so a manual run covers the same
  // trailing window as the scheduled one and its result means the same thing.
  const to   = new Date();
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - LOOKBACK_DAYS);
  const fromStr = from.toISOString().slice(0, 10);
  const toStr   = to.toISOString().slice(0, 10);

  const result = await syncAllRamp(supabase, fromStr, toStr);
  return { ...result, window: { from: fromStr, to: toStr } };
}

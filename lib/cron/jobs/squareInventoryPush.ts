/**
 * Reflects cold storage onto Square for every mapped keg and can SKU.
 *
 * Its own job rather than a step inside the consumption sync, because the push
 * has to cover stock that ARRIVED as well as stock that left. Run as a side
 * effect of taproom can sales it only ever restated beers that sold through the
 * till: a packaging run pushed nothing, a wholesale-only week pushed nothing,
 * and kegs were never pushed at all.
 *
 * Absolute counts, so running it more often is always safe and running it late
 * costs nothing but staleness.
 *
 * While lib/square/pushGate is shut this measures and reports without writing —
 * `applied` will be 0 and `pushEnabled` false in the run detail.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { pushInventoryToSquare } from "@/lib/production/pushInventoryToSquare";

export async function runSquareInventoryPushJob(supabase: SupabaseClient) {
  const result = await pushInventoryToSquare(supabase);
  return {
    ...result,
    // Planned-but-not-applied is the normal state while the gate is shut; make
    // that legible in the cron monitor rather than looking like a failed run.
    plannedCount: result.planned.length,
  };
}

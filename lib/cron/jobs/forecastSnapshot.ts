/**
 * Saves today's base-case Financials forecast, so that once a month has
 * happened the page can show what was expected of it against what it came to.
 *
 * The work is in lib/finance/forecast/snapshots.server.ts. It overwrites the
 * open month's own rows and nothing else, so a second run on the same day —
 * or a manual one — only refreshes them. It reads statements; it changes none.
 */
// Side-effect import: registers the balance providers the cash-on-hand read
// resolves against, exactly as the financials route does.
import "@/lib/finance/balances/methods";
import type { SupabaseClient } from "@supabase/supabase-js";
import { saveForecastSnapshots } from "@/lib/finance/forecast/snapshots.server";

export async function runForecastSnapshot(supabase: SupabaseClient) {
  return saveForecastSnapshots(supabase);
}

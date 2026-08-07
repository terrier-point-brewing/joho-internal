/**
 * Refreshes the Square catalog mirror.
 *
 * The mirror is what every backend consumer reads — revenue's GL account
 * lookup, draft sell-through, the pour sizes shrinkage is measured from, the
 * inventory push, the mapping grid. Until this job existed nothing refreshed it
 * on a schedule: `syncSquareCatalog` had exactly one entry point, the "Refresh
 * from Square" button, so the mirror was only ever as current as the last time
 * a person pressed it. It once sat twelve days stale.
 *
 * The narrow, real reason to run on a schedule is what nothing else can catch:
 *
 *  - RETIREMENTS. `is_deleted` is set only by this sync's deletion pass, by
 *    noticing which mirror rows a full fetch did not return. Square never tells
 *    you what it stopped returning, so a SKU retired there stays "live" here
 *    forever and lib/square/linkHealth reports a clean bill of health while
 *    pointing at a corpse.
 *  - Square's own fields drifting: names, prices, sku/upc, the inventory flags.
 *
 * It is NOT the fix for a newly created SKU. Linking one mirrors it immediately
 * (lib/square/ensureCatalogItem), which closes that gap at the source instead of
 * leaving it open for however long the interval happens to be.
 *
 * Derived volumes are never rewritten here — see `syncSquareCatalog`. A rename
 * that implies a different pour size is reported in `volumeMismatches` and left
 * for a human, because that column is what historical pours are measured
 * against and moving it restates the past.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { syncSquareCatalog } from "@/lib/square/syncCatalog";

export async function runSquareCatalogSync(supabase: SupabaseClient) {
  const result = await syncSquareCatalog(supabase);

  return {
    ...result,
    // Surfaced as its own scalar so the monitor shows it without unpacking the
    // array — a rename that moved a pour size is the one outcome of this job
    // that needs a person.
    volumeMismatchCount: result.volumeMismatches.length,
  };
}

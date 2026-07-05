// Server-only accessor for the stored brewery timezone. Kept separate from the
// isomorphic `breweryTimezone.ts` so its Supabase service-role client and
// next/cache imports never end up in a client bundle. Import this only from
// server code (route handlers, lib/square data access).

import { unstable_cache } from "next/cache";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  BREWERY_TIMEZONE_KEY,
  BREWERY_TIMEZONE_TAG,
  DEFAULT_BREWERY_TZ,
  isSupportedTimezone,
} from "./breweryTimezone";

// Uncached read of the stored zone, validated against the supported list so a
// stale/garbage value can never poison every downstream calculation.
async function readBreweryTimezone(): Promise<string> {
  const supabase = createSupabaseAdminClient();
  const { data } = await supabase
    .from("system_settings")
    .select("value")
    .eq("key", BREWERY_TIMEZONE_KEY)
    .maybeSingle();
  return isSupportedTimezone(data?.value) ? data.value : DEFAULT_BREWERY_TZ;
}

// The active brewery zone. Cached cross-request (the value changes at most a
// handful of times ever) and revalidated by tag when an admin saves a new one.
export const getBreweryTimezone = unstable_cache(
  readBreweryTimezone,
  ["brewery-timezone"],
  { revalidate: 300, tags: [BREWERY_TIMEZONE_TAG] },
);

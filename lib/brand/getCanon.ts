import { unstable_cache } from "next/cache";
import type { BrandCanon } from "./canon.types";
import { seedCanon } from "./seedCanon";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

interface SupabaseLikeClient {
  from(table: string): {
    select(columns: string): {
      eq(
        column: string,
        value: string,
      ): {
        limit(n: number): Promise<{ data: { document: BrandCanon }[] | null; error: unknown }>;
      };
    };
  };
}

// Fetch the published canon row via the given client, falling back to
// seedCanon when there's no published row, the data is empty, the query
// errors, or the client throws. Extracted from getCanon() for testability
// with a fake client.
export async function getCanonFrom(client: SupabaseLikeClient): Promise<BrandCanon> {
  try {
    const { data, error } = await client
      .from("brand_canon_versions")
      .select("document")
      .eq("status", "published")
      .limit(1);

    if (error || !data || data.length === 0) {
      return seedCanon;
    }

    return data[0].document;
  } catch {
    return seedCanon;
  }
}

// A client stub whose every query resolves to "no rows", so getCanonFrom's
// existing empty-data branch falls back to seedCanon. Used when the env vars
// required to build a real Supabase client aren't present (e.g. build-time
// contexts without env configured) so we never throw constructing the client.
export const seedFallbackClient: SupabaseLikeClient = {
  from() {
    return {
      select() {
        return {
          eq() {
            return {
              limit() {
                return Promise.resolve({ data: [], error: null });
              },
            };
          },
        };
      },
    };
  },
};

// Service-role client. The canon is presentation config the server renders
// into <head> before it knows who is asking — BrandStyle/BrandChrome run in
// the root layout on every route — so the read is a server concern and never
// a per-user one. It used to go through the cookieless ANON client, which
// meant brand_canon_versions had to stay readable over the public Data API
// purely so the app could style its own pages. Reading it with the service
// role instead let that policy be dropped entirely (see
// 20261003090001_brand_tables_service_role_only.sql).
//
// Still cookieless, so the "no cookies()/headers()" property the anon client
// was chosen for is preserved. (That property no longer decides anything on
// its own: the root layout's getSessionUser() already opts the whole tree
// into dynamic rendering — see app/layout.tsx.)
//
// Same shape as getBrandChromeEnabled() in lib/settings/brandChrome.server.ts,
// which is the sibling read in this very layout: the root layout is
// prerendered at build time (incl. /_not-found) where the service-role key is
// absent and createSupabaseAdminClient() would throw, so guard on the key and
// fall back to the seed there.
function createServiceRoleClient(): SupabaseLikeClient {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return seedFallbackClient;
  }
  return createSupabaseAdminClient() as unknown as SupabaseLikeClient;
}

// Cached across requests under the 'brand-canon' tag. Phase 1's canon editor
// calls revalidateTag('brand-canon', ...) on publish so edits reflect without
// a redeploy; until then the published row (or the seed fallback) is cached.
// `revalidate` matters as much as the tag. The tag only busts on publish, which
// covers edits made through the UI — but the canon is ALSO edited by migrations
// (20260902–20260905 all rewrote the published document directly), and those
// call nothing. Without a revalidate window the app served a pre-migration
// snapshot indefinitely: the palette expansion landed in Postgres and the Color
// tab kept reporting every dark role as "derived", because the canon it held
// genuinely had no dark map.
//
// Five minutes is the trade: a schema-level change surfaces on its own without
// a redeploy, and a UI publish is still instant via revalidateTag.
// Not per-user, and never was: the cache key is constant because the canon is
// the same document for every caller. Switching the client to service-role
// doesn't change that — it only changes which credential fetches it.
const fetchCanonCached = unstable_cache(
  async () => getCanonFrom(createServiceRoleClient()),
  ["brand-canon"],
  { tags: ["brand-canon"], revalidate: 300 },
);

export async function getCanon(): Promise<BrandCanon> {
  return fetchCanonCached();
}

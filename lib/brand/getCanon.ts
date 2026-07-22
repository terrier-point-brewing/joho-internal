import { createClient } from "@supabase/supabase-js";
import { unstable_cache } from "next/cache";
import type { BrandCanon } from "./canon.types";
import { seedCanon } from "./seedCanon";

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
const seedFallbackClient: SupabaseLikeClient = {
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

// Cookieless anon client. Published canon is readable by anon (RLS allows
// SELECT where status='published'), so reading it touches no cookies()/
// headers() — that's what keeps consumers (root layout, pages) statically
// renderable instead of forcing the whole route tree dynamic.
function createCookielessClient(): SupabaseLikeClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    return seedFallbackClient;
  }
  const client = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  return client as unknown as SupabaseLikeClient;
}

// Cached across requests under the 'brand-canon' tag. Phase 1's canon editor
// calls revalidateTag('brand-canon', ...) on publish so edits reflect without
// a redeploy; until then the published row (or the seed fallback) is cached.
const fetchCanonCached = unstable_cache(
  async () => getCanonFrom(createCookielessClient()),
  ["brand-canon"],
  { tags: ["brand-canon"] },
);

export async function getCanon(): Promise<BrandCanon> {
  return fetchCanonCached();
}

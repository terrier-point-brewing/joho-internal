import { createSupabaseServerClient } from "@/lib/supabase/server";
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

export async function getCanon(): Promise<BrandCanon> {
  const client = await createSupabaseServerClient();
  return getCanonFrom(client as unknown as SupabaseLikeClient);
}

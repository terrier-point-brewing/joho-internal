// Server-only accessor for the "apply brand to the internal app" toggle. When
// on, BrandChrome overrides the ops --color-* tokens with the brand palette.
// Stored in system_settings (jsonb boolean), default OFF so the zinc/amber
// system is always the fallback.

import { unstable_cache } from "next/cache";
import { revalidateTag } from "next/cache";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const BRAND_CHROME_KEY = "brand_chrome_enabled";
export const BRAND_CHROME_TAG = "brand-chrome-setting";

async function readBrandChromeEnabled(): Promise<boolean> {
  // BrandChrome runs in the root layout, which is prerendered (incl. static
  // pages like /_not-found) at build time where the service-role key is absent.
  // Without this guard createSupabaseAdminClient() throws and fails the build.
  // Default to off there; at runtime (key present) the real value is read, and
  // toggling revalidates the tag so pages pick it up.
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return false;

  try {
    const supabase = createSupabaseAdminClient();
    const { data } = await supabase
      .from("system_settings")
      .select("value")
      .eq("key", BRAND_CHROME_KEY)
      .maybeSingle();
    // jsonb boolean (also tolerate a "true" string just in case)
    return data?.value === true || data?.value === "true";
  } catch {
    return false;
  }
}

// Cached cross-request; revalidated by tag when an admin flips the toggle. Short
// TTL backstop so a manual DB change still propagates.
export const getBrandChromeEnabled = unstable_cache(
  readBrandChromeEnabled,
  ["brand-chrome-enabled"],
  { revalidate: 60, tags: [BRAND_CHROME_TAG] },
);

export async function setBrandChromeEnabled(enabled: boolean, updatedBy?: string): Promise<void> {
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase.from("system_settings").upsert({
    key: BRAND_CHROME_KEY,
    value: enabled,
    updated_at: new Date().toISOString(),
    ...(updatedBy ? { updated_by: updatedBy } : {}),
  });
  if (error) throw new Error("Failed to save brand-chrome setting");
  revalidateTag(BRAND_CHROME_TAG, "max");
}

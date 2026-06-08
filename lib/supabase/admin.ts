import { createClient } from "@supabase/supabase-js";

/** Service-role client — bypasses RLS. Server-side only. */
export function createSupabaseAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set. Add it to .env.local from the Supabase Dashboard → Settings → API.",
    );
  }
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

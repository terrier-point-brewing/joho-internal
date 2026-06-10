import { createClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

/** Service-role client — bypasses RLS. Server-side only. */
export function createSupabaseAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    env.supabaseServiceKey(),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

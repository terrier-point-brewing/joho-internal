import { createClient, SupabaseClient } from "@supabase/supabase-js";

// Lazy-initialize so the client isn't created at module load time.
// This prevents Next.js from throwing "supabaseUrl is required" when
// importing this module during the build's static page-data collection
// phase, where env vars aren't available.
let _client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (!_client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_ANON_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY must be set");
    _client = createClient(url, key);
  }
  return _client;
}

export const supabase = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    return (getClient() as unknown as Record<string | symbol, unknown>)[prop];
  },
});

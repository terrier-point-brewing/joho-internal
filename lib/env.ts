/**
 * Central registry for all server-side environment variables.
 *
 * Each accessor throws at call-time (not module-load time) so the error
 * surfaces as close to the failed request as possible while still being
 * caught by the route's error handler.
 *
 * NEXT_PUBLIC_* vars are left inline in their respective Supabase client
 * files so Next.js's static-analysis replacement continues to work.
 */

function require(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

export const env = {
  /** Supabase service-role key (bypasses RLS). Server-side only. */
  supabaseServiceKey: () => require("SUPABASE_SERVICE_ROLE_KEY"),

  /** Square Bearer token for the Connect v2 API. */
  squareAccessToken: () => require("SQUARE_ACCESS_TOKEN"),

  /** Square location ID used in inventory/order queries. */
  squareLocationId: () => require("SQUARE_LOCATION_ID"),

  /**
   * Resend API key for transactional email.
   * Returns undefined if unset — callers should skip sending gracefully.
   */
  resendApiKey: (): string | undefined => process.env.RESEND_API_KEY,

  /** Ramp OAuth client credentials. */
  rampClientId:     () => require("RAMP_CLIENT_ID"),
  rampClientSecret: () => require("RAMP_CLIENT_SECRET"),

  /**
   * Plaid app-level credentials. The per-bank `access_token` is NOT here — it
   * is minted per link at runtime and lives in
   * integration_connections.credentials, which is the whole reason that column
   * exists. See docs/finance/balance-methods-handoff.md § 3c.
   */
  plaidClientId: () => require("PLAID_CLIENT_ID"),
  plaidSecret:   () => require("PLAID_SECRET"),

  /** "production" (the Trial plan lives here too) or "sandbox". */
  plaidEnv: (): string => process.env.PLAID_ENV ?? "production",

  /**
   * OAuth redirect URI, required by OAuth institutions — Chase is one — and it
   * must match a URI registered in the Plaid dashboard character for
   * character. Undefined when unset so a sandbox link still works.
   */
  plaidRedirectUri: (): string | undefined => process.env.PLAID_REDIRECT_URI,

  /**
   * Public base URL for the app (e.g. https://internal.johobrewing.com).
   * Used when constructing absolute links in emails.
   *
   * Falls back on empty as well as unset: an env var present but blank would
   * otherwise yield host-less links in outgoing email.
   */
  appUrl: (): string => process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
} as const;

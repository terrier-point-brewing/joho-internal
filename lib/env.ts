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
   * Public base URL for the app (e.g. https://app.terrierpoint.com).
   * Used when constructing absolute links in emails.
   */
  appUrl: (): string => process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",

  /**
   * Optional Square catalog variation ID for the "Ingredient Deposit" item.
   * When set, deposit invoices reference this catalog variation for consistent
   * naming in the Square dashboard. Falls back to a catalog name search if unset.
   */
  squareIngredientDepositVariationId: (): string | undefined =>
    process.env.SQUARE_INGREDIENT_DEPOSIT_VARIATION_ID,
} as const;

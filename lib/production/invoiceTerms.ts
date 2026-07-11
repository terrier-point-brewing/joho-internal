import type { SupabaseClient } from "@supabase/supabase-js";

export type InvoiceKind = "deposit" | "export";

const SETTINGS_KEY: Record<InvoiceKind, string> = {
  deposit: "deposit_invoice_due_days",
  export: "export_invoice_due_days",
};

/** Fallback when the setting row is missing or unreadable. */
const DEFAULT_NET_TERMS_DAYS = 30;

/**
 * The single configured net-terms value (in days) for the given invoice type,
 * read from system_settings. There is no per-partner override — this is the one
 * source of truth. Falls back to 30 when the row is missing or the read errors.
 */
export async function getNetTermsDays(
  supabase: SupabaseClient,
  kind: InvoiceKind,
): Promise<number> {
  const key = SETTINGS_KEY[kind];
  const { data, error } = await supabase
    .from("system_settings")
    .select("value")
    .eq("key", key)
    .single();
  if (error) {
    console.error(`[invoiceTerms] failed to read ${key}:`, error);
    return DEFAULT_NET_TERMS_DAYS;
  }
  const value = data?.value as number | null | undefined;
  return typeof value === "number" ? value : DEFAULT_NET_TERMS_DAYS;
}

/** Today's server date as YYYY-MM-DD (UTC), matching the app's other date stamps. */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Adds `days` calendar days to an ISO date (YYYY-MM-DD) and returns YYYY-MM-DD.
 * Uses UTC component math so the result is timezone-independent.
 */
export function addDaysIso(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

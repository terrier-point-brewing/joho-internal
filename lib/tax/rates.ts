/**
 * Canonical tax-rates accessor (`tax_rates`) — the single source of truth
 * for every excise/sales/local/transit rate value used across production
 * excise, the beer-excise party module, and the NC DOR Sales & Use engine.
 * Rate *structure* (which keys exist, form-line numbers, etc.) stays in
 * code; rate *values* live in this table so they can be updated without a
 * deploy. Every consumer reads rates through `listTaxRates`/`getTaxRate`
 * by key, never by hand-rolled query.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface TaxRate {
  id: string;
  key: string;
  name: string;
  category: "excise" | "sales" | "local" | "transit";
  party_key: string | null;
  basis: "per_bbl" | "per_gallon" | "percent";
  rate: number;
  is_active: boolean;
}

/** Well-known rate keys referenced directly by name (not derived). */
export const TAX_RATE_KEYS = {
  NC_DOR_BEER_EXCISE: "nc_dor_beer_excise",
  FEDERAL_BEER_EXCISE: "federal_beer_excise",
  NC_SALES_STATE: "nc_sales_state",
} as const;

/** Key for a Form E-500 rate line (4–12), e.g. `ncSalesLineKey(4)` → `"nc_sales_line_4"`. */
export function ncSalesLineKey(n: number): string {
  return `nc_sales_line_${n}`;
}

/** Key for a county's local tax rate, e.g. `ncLocalKey("WAKE")` → `"nc_local_WAKE"`. */
export function ncLocalKey(code: string): string {
  return `nc_local_${code}`;
}

/** Key for a county's transit tax rate, e.g. `ncTransitKey("WAKE")` → `"nc_transit_WAKE"`. */
export function ncTransitKey(code: string): string {
  return `nc_transit_${code}`;
}

/** Collapse rate rows into a flat `{ key: rate }` lookup map. */
export function buildRateMap(rows: TaxRate[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const row of rows) {
    map[row.key] = row.rate;
  }
  return map;
}

export async function listTaxRates(
  sb: SupabaseClient,
  opts?: { category?: TaxRate["category"]; activeOnly?: boolean },
): Promise<TaxRate[]> {
  let query = sb.from("tax_rates").select("id, key, name, category, party_key, basis, rate, is_active");
  if (opts?.category) {
    query = query.eq("category", opts.category);
  }
  if (opts?.activeOnly) {
    query = query.eq("is_active", true);
  }
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data as TaxRate[] | null) ?? [];
}

/** The active row's rate for `key`, or `null` if no active row exists. */
export async function getTaxRate(sb: SupabaseClient, key: string): Promise<number | null> {
  const { data, error } = await sb
    .from("tax_rates")
    .select("rate")
    .eq("key", key)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { rate: number } | null)?.rate ?? null;
}

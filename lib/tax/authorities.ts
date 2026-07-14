/**
 * Receiving-party tax authorities (`tax_authorities`) — the registry of
 * agencies TPB files/pays excise to (NC DOR, TTB, ...), each with an optional
 * registration number. Read-mostly reference data; the only write path is
 * updating a single authority's registration number.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface TaxAuthority {
  key: string;
  label: string;
  kind: "filing" | "excise" | "both";
  registration_number: string | null;
  display_order: number;
}

export async function listAuthorities(sb: SupabaseClient): Promise<TaxAuthority[]> {
  const { data, error } = await sb
    .from("tax_authorities")
    .select("key, label, kind, registration_number, display_order")
    .order("display_order");
  if (error) throw new Error(error.message);
  return (data as TaxAuthority[] | null) ?? [];
}

export async function updateRegistration(
  sb: SupabaseClient,
  key: string,
  registration_number: string | null,
): Promise<void> {
  const value = registration_number && registration_number.trim() !== "" ? registration_number : null;
  const { error } = await sb
    .from("tax_authorities")
    .update({ registration_number: value, updated_at: new Date().toISOString() })
    .eq("key", key);
  if (error) throw new Error(error.message);
}

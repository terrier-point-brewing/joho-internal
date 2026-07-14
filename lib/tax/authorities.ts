/**
 * Receiving-party tax authorities (`tax_authorities`) — the registry of
 * agencies TPB files/pays excise to (NC DOR, TTB, ...). Read-only reference
 * data; per-authority registration/license numbers now live at a finer grain
 * in `tax_registrations` (see lib/tax/registrations.ts).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface TaxAuthority {
  key: string;
  label: string;
  display_order: number;
}

export async function listAuthorities(sb: SupabaseClient): Promise<TaxAuthority[]> {
  const { data, error } = await sb
    .from("tax_authorities")
    .select("key, label, display_order")
    .order("display_order");
  if (error) throw new Error(error.message);
  return (data as TaxAuthority[] | null) ?? [];
}

/**
 * Singleton tax entity profile storage (`tax_entity_profile`) — the brewery's
 * own legal/contact identity (legal name, SSN, contact info, mailing
 * address) used to prefill filings across every receiving party. Unlike
 * `tax_filing_profiles` (per-party, `lib/tax/profiles.ts`), this is a single
 * row identified by `id = true`, with schema keys mapped 1:1 onto columns.
 *
 * Same blank-means-leave-unchanged merge convention as `putProfile` — the UI
 * never round-trips the real value for the `sensitive` SSN field, so a blank
 * submitted value must not wipe the stored one.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FieldSpec } from "./types";
import { US_STATES } from "./usStates";

export const ENTITY_PROFILE_SCHEMA: FieldSpec[] = [
  { key: "legal_name", label: "Legal entity name", type: "text", required: true },
  { key: "trade_name", label: "Trade name (DBA)", type: "text" },
  { key: "ssn", label: "SSN (only if sole proprietor / no FEIN)", type: "text", sensitive: true },
  { key: "contact_name", label: "Primary contact name", type: "text" },
  { key: "contact_email", label: "Primary contact email", type: "email" },
  { key: "contact_phone", label: "Primary contact phone", type: "tel" },
  { key: "fax_number", label: "Fax number", type: "tel" },
  { key: "address_line1", label: "Address line 1", type: "text" },
  { key: "address_line2", label: "Address line 2", type: "text" },
  { key: "city", label: "City", type: "text" },
  { key: "state", label: "State", type: "text" },
  { key: "postal_code", label: "Postal code", type: "text" },
  { key: "state_of_domicile", label: "State of domicile", type: "select", options: US_STATES },
];

export type EntityProfileValues = Record<string, string>;

export async function getEntityProfile(sb: SupabaseClient): Promise<EntityProfileValues> {
  const { data, error } = await sb.from("tax_entity_profile").select("*").eq("id", true).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return {};

  const row = data as Record<string, unknown>;
  const values: EntityProfileValues = {};
  for (const field of ENTITY_PROFILE_SCHEMA) {
    const value = row[field.key];
    if (value != null) values[field.key] = String(value);
  }
  return values;
}

export async function putEntityProfile(sb: SupabaseClient, values: EntityProfileValues): Promise<void> {
  const existing = await getEntityProfile(sb);
  const merged: EntityProfileValues = { ...existing };
  for (const [key, value] of Object.entries(values)) {
    // Blank = "leave unchanged" so a masked SSN round-trip can't wipe it.
    if (value !== "" && value != null) merged[key] = value;
  }

  const { error } = await sb
    .from("tax_entity_profile")
    .upsert({ id: true, ...merged, updated_at: new Date().toISOString() }, { onConflict: "id" });
  if (error) throw new Error(error.message);
}

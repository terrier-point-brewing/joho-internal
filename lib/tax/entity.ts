/**
 * Singleton tax entity profile storage (`tax_entity_profile`) — the
 * brewery's own business identity (legal name, trade name, mailing address,
 * general phone/fax) used to prefill filings across every receiving party.
 * It carries TWO addresses: the legal entity's (`address_*`, what state and
 * county filings ask for) and the brewery premises' (`premises_*`, where the
 * beer is actually made — what TTB asks for, county included). They are
 * different places; never substitute one for the other.
 * The person who signs filings on the business's behalf is a SEPARATE
 * singleton, `tax_legal_representative` (lib/tax/legalRepresentative.ts) —
 * this table is business-only. Unlike `tax_filing_profiles` (per-party,
 * `lib/tax/profiles.ts`), this is a single row identified by `id = true`,
 * with schema keys mapped 1:1 onto columns.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FieldSpec } from "./types";

export const ENTITY_PROFILE_SCHEMA: FieldSpec[] = [
  { key: "legal_name", label: "Legal entity name", type: "text", required: true },
  { key: "trade_name", label: "Trade name (DBA)", type: "text" },
  { key: "contact_phone", label: "Phone number", type: "tel" },
  { key: "fax_number", label: "Fax number", type: "tel" },
  { key: "address_line1", label: "Address line 1", type: "text" },
  { key: "address_line2", label: "Address line 2", type: "text" },
  { key: "city", label: "City", type: "text" },
  { key: "state", label: "State", type: "text" },
  { key: "postal_code", label: "Postal code", type: "text" },
  { key: "premises_address_line1", label: "Brewery premises — address line 1", type: "text" },
  { key: "premises_address_line2", label: "Brewery premises — address line 2", type: "text" },
  { key: "premises_city", label: "Brewery premises — city", type: "text" },
  { key: "premises_county", label: "Brewery premises — county", type: "text" },
  { key: "premises_state", label: "Brewery premises — state", type: "text" },
  { key: "premises_postal_code", label: "Brewery premises — postal code", type: "text" },
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
    if (value !== "" && value != null) merged[key] = value;
  }

  const { error } = await sb
    .from("tax_entity_profile")
    .upsert({ id: true, ...merged }, { onConflict: "id" });
  if (error) throw new Error(error.message);
}

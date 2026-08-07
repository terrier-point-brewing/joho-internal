/**
 * Singleton legal representative storage (`tax_legal_representative`) — the
 * individual who signs/certifies filings on behalf of the business, distinct
 * from `tax_entity_profile` (the business itself — see lib/tax/entity.ts).
 * Same singleton (`id = true`) and blank-means-leave-unchanged merge
 * convention as `tax_entity_profile` — the UI never round-trips the real
 * value for the `sensitive` SSN field, so a blank submitted value must not
 * wipe the stored one.
 *
 * "State of Domicile" is never a column here — callers read this record's
 * `state` directly and label it "State of Domicile" wherever needed.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FieldSpec } from "./types";
import { US_STATES } from "./usStates";

export const LEGAL_REPRESENTATIVE_SCHEMA: FieldSpec[] = [
  { key: "name", label: "Full name", type: "text", required: true },
  { key: "title", label: "Title", type: "text" },
  { key: "phone", label: "Phone", type: "tel" },
  { key: "email", label: "Email", type: "email" },
  { key: "ssn", label: "SSN (only if no FEIN on file)", type: "text", sensitive: true },
  { key: "address_line1", label: "Address line 1", type: "text" },
  { key: "address_line2", label: "Address line 2", type: "text" },
  { key: "city", label: "City", type: "text" },
  { key: "state", label: "State", type: "select", options: US_STATES },
  { key: "postal_code", label: "Postal code", type: "text" },
];

export type LegalRepresentativeValues = Record<string, string>;

export async function getLegalRepresentative(sb: SupabaseClient): Promise<LegalRepresentativeValues> {
  const { data, error } = await sb.from("tax_legal_representative").select("*").eq("id", true).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return {};

  const row = data as Record<string, unknown>;
  const values: LegalRepresentativeValues = {};
  for (const field of LEGAL_REPRESENTATIVE_SCHEMA) {
    const value = row[field.key];
    if (value != null) values[field.key] = String(value);
  }
  return values;
}

export async function putLegalRepresentative(sb: SupabaseClient, values: LegalRepresentativeValues): Promise<void> {
  const existing = await getLegalRepresentative(sb);
  const merged: LegalRepresentativeValues = { ...existing };
  for (const [key, value] of Object.entries(values)) {
    // Blank = "leave unchanged" so a masked SSN round-trip can't wipe it.
    if (value !== "" && value != null) merged[key] = value;
  }

  const { error } = await sb
    .from("tax_legal_representative")
    .upsert({ id: true, ...merged }, { onConflict: "id" });
  if (error) throw new Error(error.message);
}

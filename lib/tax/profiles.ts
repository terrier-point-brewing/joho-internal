/**
 * Per-party filing profile storage (`tax_filing_profiles`) — the static/
 * semi-static values (contact info, FEIN/SSN, account IDs, ...) used to
 * prefill a party's worksheet. Values are keyed by whatever field keys the
 * party's `settingsSchema` (lib/tax/types.ts `FieldSpec[]`) declares.
 *
 * `sensitive` fields (SSN/FEIN) must never reach the browser in the clear —
 * `maskSensitive` replaces their value with a `"present"`/`"absent"` status
 * string for the GET route. Because the UI never round-trips the real value
 * for a masked field, `putProfile` treats a blank submitted value as "leave
 * this field unchanged" and merges onto the existing stored values, rather
 * than overwriting the stored SSN with an empty string.
 *
 * Takes an injected `SupabaseClient` (same convention as schedules.ts /
 * tasks.ts) so this is testable with a stub.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FieldSpec, TaxFilingProfileValues } from "./types";

export async function getProfile(sb: SupabaseClient, party: string): Promise<TaxFilingProfileValues> {
  const { data, error } = await sb
    .from("tax_filing_profiles")
    .select("values")
    .eq("party_key", party)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return ((data as { values?: TaxFilingProfileValues } | null)?.values as TaxFilingProfileValues | undefined) ?? {};
}

export async function putProfile(
  sb: SupabaseClient,
  party: string,
  values: TaxFilingProfileValues,
): Promise<void> {
  const existing = await getProfile(sb, party);
  const merged: TaxFilingProfileValues = { ...existing };
  for (const [key, value] of Object.entries(values)) {
    // Blank = "leave unchanged" so a masked round-trip (the UI never sends
    // the real value for a `sensitive` field) can't wipe the stored value.
    if (value !== "" && value != null) merged[key] = value;
  }

  const { error } = await sb
    .from("tax_filing_profiles")
    .upsert(
      { party_key: party, values: merged, updated_at: new Date().toISOString() },
      { onConflict: "party_key" },
    );
  if (error) throw new Error(error.message);
}

/**
 * Replaces every `sensitive` schema field's value with `"present"` (non-empty
 * stored value) or `"absent"` (empty/missing) — the only status the browser
 * is ever allowed to see for SSN/FEIN-type fields. Non-sensitive fields pass
 * through unchanged.
 */
export function maskSensitive(values: TaxFilingProfileValues, schema: FieldSpec[]): Record<string, string> {
  const masked: Record<string, string> = { ...values };
  for (const field of schema) {
    if (!field.sensitive) continue;
    const value = values[field.key];
    masked[field.key] = value && value.length > 0 ? "present" : "absent";
  }
  return masked;
}

/**
 * The deliberate escape hatch from the write-only `sensitive` contract above:
 * returns the REAL stored value for each `sensitive` schema field (omitting
 * ones with no stored value), for an explicit user-initiated "unmask" action.
 * Non-sensitive fields are never included — callers already have those from
 * the regular masked GET, so this only ever carries the one thing that GET
 * withholds. Route handlers must gate this behind a stricter role check than
 * the masked GET (see the reveal routes under app/api/tax/).
 */
export function pickSensitiveValues(values: TaxFilingProfileValues, schema: FieldSpec[]): Record<string, string> {
  const revealed: Record<string, string> = {};
  for (const field of schema) {
    if (!field.sensitive) continue;
    const value = values[field.key];
    if (value && value.length > 0) revealed[field.key] = value;
  }
  return revealed;
}

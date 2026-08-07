/**
 * Which Square taxes an ACTIVE tax filing currently depends on.
 *
 * The two settings screens that touch a Square tax answer opposite questions —
 * Finance → GL Mapping picks the liability account a tax's collections are
 * credited to, while Settings → Tax → Tax Filing picks WHICH Square tax plays a
 * role in a return (`settingsSchema` fields marked `source: "square_tax"`).
 * Neither could see the other, so a tax could be marked excluded (or left
 * unmapped) in GL Mapping while a live return still computed tax owed from it:
 * the filing says money is due, the balance sheet says it was never collected,
 * and nothing anywhere says the two disagree.
 *
 * This is the bridge. GL Mapping renders the returned count per tax, so the
 * dependency is visible at the moment someone is about to break it.
 *
 * "Active" means the party has at least one active row in `tax_schedules`. A
 * party whose schedules are all paused still holds its profile values, but it
 * is not currently filing anything, so excluding its tax breaks nothing today.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { listParties } from "./registry";
import "./parties";

/** One active filing's dependency on one Square tax. */
export interface SquareTaxReference {
  party_key: string;
  party_label: string;
  /** The `settingsSchema` field holding the id, e.g. "Square General Sales Tax". */
  field_label: string;
}

/**
 * square_tax_id -> every active filing referencing it. Taxes no active filing
 * references are absent rather than present-with-[], so callers can treat a
 * missing key and an empty list the same way.
 */
export async function listSquareTaxUsage(
  sb: SupabaseClient,
): Promise<Map<string, SquareTaxReference[]>> {
  const parties = listParties().filter((p) =>
    p.settingsSchema.some((f) => f.source === "square_tax"),
  );
  const usage = new Map<string, SquareTaxReference[]>();
  if (parties.length === 0) return usage;

  const partyKeys = parties.map((p) => p.key);

  const [schedules, profiles] = await Promise.all([
    sb.from("tax_schedules").select("filing_key").eq("active", true).in("filing_key", partyKeys),
    sb.from("tax_filing_profiles").select("filing_key, values").in("filing_key", partyKeys),
  ]);
  if (schedules.error) throw new Error(schedules.error.message);
  if (profiles.error) throw new Error(profiles.error.message);

  const activeParties = new Set(
    ((schedules.data ?? []) as { filing_key: string }[]).map((r) => r.filing_key),
  );
  const valuesByParty = new Map(
    ((profiles.data ?? []) as { filing_key: string; values: Record<string, string> | null }[]).map(
      (r) => [r.filing_key, r.values ?? {}],
    ),
  );

  for (const party of parties) {
    if (!activeParties.has(party.key)) continue;
    const values = valuesByParty.get(party.key) ?? {};
    for (const field of party.settingsSchema) {
      if (field.source !== "square_tax") continue;
      const taxId = values[field.key];
      if (!taxId) continue;
      const refs = usage.get(taxId) ?? [];
      refs.push({ party_key: party.key, party_label: party.label, field_label: field.label });
      usage.set(taxId, refs);
    }
  }

  return usage;
}

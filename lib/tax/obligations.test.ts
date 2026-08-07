/**
 * Drift guard between the `public.tax_obligations` lookup table and the party
 * registry in `lib/tax/parties/`.
 *
 * A filing obligation exists in two places and needs both:
 *   1. a row in `tax_obligations` — what `tax_schedules.filing_key`,
 *      `tax_tasks.filing_key` and `tax_filing_profiles.filing_key` point at;
 *   2. a `TaxPartyTemplate` registered in code — the periods, worksheet math,
 *      due rules and React worksheet.
 *
 * Having only the row gives you a schedule whose `getParty()` throws. Having
 * only the template gives you a template no schedule can be created against,
 * because the FK rejects the insert. Neither failure shows up at compile time,
 * so this test pins the set both sides must agree on.
 *
 * When you add an obligation: add the template, add the import in
 * `lib/tax/parties/index.ts`, add the seed row in a migration, and add it
 * here. The list below is the contract, not a snapshot to bump blindly.
 */
import { describe, it, expect } from "vitest";
import { listParties } from "./registry";
import "./parties";

/**
 * Mirrors the rows seeded by
 * supabase/migrations/20261003090000_tax_obligations_lookup.sql.
 * `label` is the template's label, copied into the table for SQL readability —
 * the UI renders `TaxPartyTemplate.label`, never the column.
 */
const SEEDED_OBLIGATIONS = [
  { key: "nc_dor_sales_use", authority_key: "nc_dor", label: "NC DOR — Sales & Use Tax" },
  { key: "nc_dor_beer_excise", authority_key: "nc_dor", label: "NC DOR — Beer Excise Tax (B-C-710)" },
  { key: "wake_county_food_beverage", authority_key: "wake_county", label: "Wake County — Prepared Food & Beverage Tax" },
] as const;

describe("tax_obligations ↔ party registry", () => {
  it("every registered party template has a seeded obligation row", () => {
    const seeded = new Set<string>(SEEDED_OBLIGATIONS.map((o) => o.key));
    const missing = listParties()
      .map((p) => p.key)
      .filter((key) => !seeded.has(key));
    expect(missing, "party template(s) with no tax_obligations row — schedules for these will fail the FK").toEqual([]);
  });

  it("every seeded obligation row has a registered party template", () => {
    const registered = new Set(listParties().map((p) => p.key));
    const orphaned = SEEDED_OBLIGATIONS.map((o) => o.key).filter((key) => !registered.has(key));
    expect(orphaned, "tax_obligations row(s) with no party template — getParty() will throw for these").toEqual([]);
  });

  it("the label copied into tax_obligations matches the template's label", () => {
    const byKey = new Map(listParties().map((p) => [p.key, p.label]));
    for (const obligation of SEEDED_OBLIGATIONS) {
      expect(byKey.get(obligation.key), `tax_obligations.label drifted for ${obligation.key}`).toBe(obligation.label);
    }
  });

  it("every obligation names an authority that tax_authorities actually has", () => {
    // The FK enforces this in the database; pinned here so a bad seed value in
    // a future migration fails in CI rather than at apply time.
    const KNOWN_AUTHORITIES = new Set(["nc_dor", "federal_ttb", "irs", "nc_abc", "wake_county"]);
    for (const obligation of SEEDED_OBLIGATIONS) {
      expect(KNOWN_AUTHORITIES.has(obligation.authority_key), `unknown authority ${obligation.authority_key}`).toBe(true);
    }
  });
});

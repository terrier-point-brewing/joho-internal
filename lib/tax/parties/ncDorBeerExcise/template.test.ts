import { describe, it, expect } from "vitest";
import "@/lib/tax/parties";                    // side-effect registry load
import { getParty } from "@/lib/tax/registry";
import type { WorksheetData } from "@/lib/tax/types";

describe("nc_dor_beer_excise template", () => {
  const p = getParty("nc_dor_beer_excise");
  it("is registered, monthly only", () => {
    expect(p.label).toMatch(/Beer Excise/);
    expect(p.supportedFrequencies).toEqual(["monthly"]);
  });
  it("monthly period is due the 15th of the following month", () => {
    const per = p.computePeriod("monthly", new Date("2026-03-10T12:00:00Z"));
    expect(per.start).toBe("2026-03-01");
    expect(per.end).toBe("2026-03-31");
    expect(per.due).toBe("2026-04-15");
  });
  it("quarterly is unsupported", () => expect(() => p.computePeriod("quarterly", new Date())).toThrow());
  it("settings schema is empty — filer identity now lives in Tax Profile (tax_entity_profile / tax_registrations), not a per-party settings form", () => {
    expect(p.settingsSchema).toEqual([]);
  });
  it("required registrations are NC DOR account # and the ABC wholesaler permit", () => {
    expect(p.requiredRegistrations).toEqual([
      { authorityKey: "nc_dor", registrationKey: "nc_dor_account_id", label: "NC DOR Account / License Number" },
      { authorityKey: "nc_abc", registrationKey: "abc_permit_number", label: "NC ABC Wholesaler Permit Number" },
    ]);
  });
  it("mergeWorksheet preserves manual penalty across recompute and re-derives L11", () => {
    const current: WorksheetData = { fields: { cents_penalty: 500, gal_distribution: 1000, gal_contract:0, gal_taproom:0, gal_wholesale:0, flag_timely:1, nc_excise_rate_micros:617100 } };
    const recomputed: WorksheetData = { fields: { cents_penalty: 0, gal_distribution: 2000, gal_contract:0, gal_taproom:0, gal_wholesale:0, flag_timely:1, nc_excise_rate_micros:617100 }, meta:{} };
    const m = p.mergeWorksheet(current, recomputed, {});
    expect(m.fields.gal_taxable).toBe(2000);          // computed taken from recomputed
    expect(m.fields.cents_penalty).toBe(500);          // manual preserved from current
    expect(m.fields.cents_total_payment_due).toBe((m.fields.cents_net_tax_due as number) + 500);
  });
});

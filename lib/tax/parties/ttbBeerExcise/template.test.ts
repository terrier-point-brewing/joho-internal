import { describe, it, expect } from "vitest";
import { ttbBeerExciseTemplate as t } from "./template";
import { TAX_RATE_KEYS } from "@/lib/tax/rates";
import { TTB_REDUCED_RATE_MICROS_FALLBACK } from "./rates";
import { deriveTtbFigures } from "./derive";

describe("ttbBeerExciseTemplate", () => {
  it("files quarterly on the calendar quarter", () => {
    expect(t.supportedFrequencies).toEqual(["quarterly"]);
    const p = t.computePeriod("quarterly", new Date("2026-08-11T12:00:00Z"));
    expect(p.start).toBe("2026-07-01");
    expect(p.end).toBe("2026-09-30");
  });

  it("is due 14 days after the quarter ends", () => {
    expect(t.defaultDueRule("quarterly")).toEqual({ monthOffset: 1, day: 14 });
    expect(t.computePeriod("quarterly", new Date("2026-08-11T12:00:00Z")).due).toBe("2026-10-14");
    // Q4 rolls the year over.
    expect(t.computePeriod("quarterly", new Date("2026-11-05T12:00:00Z")).due).toBe("2027-01-14");
  });

  it("rejects unsupported frequencies", () => {
    expect(() => t.defaultDueRule("monthly")).toThrow();
    expect(() => t.computePeriod("annual", new Date("2026-08-11T12:00:00Z"))).toThrow();
  });

  it("claims the TTB brewer's notice registration", () => {
    expect(t.requiredRegistrations).toEqual([
      { authorityKey: "federal_ttb", registrationKey: "ttb_brewers_notice", label: "TTB Brewer's Notice Number" },
    ]);
  });

  it("needs no settings or schedule config — identity comes from the Tax Profile", () => {
    expect(t.settingsSchema).toEqual([]);
    expect(t.scheduleConfigSchema).toEqual([]);
  });

  describe("mergeWorksheet", () => {
    const recomputed = {
      fields: deriveTtbFigures({
        bbl_distribution: 100,
        ttb_reduced_rate_micros: TTB_REDUCED_RATE_MICROS_FALLBACK,
        bbl_exports_without_tax: 0,
        cents_interest: 0,
      }),
      meta: { computedAt: "2026-10-01T00:00:00.000Z" },
    };

    it("overwrites computed fields with the fresh recompute", () => {
      const current = { fields: { ...recomputed.fields, bbl_distribution: 1, cents_tax_reduced: 1 } };
      const merged = t.mergeWorksheet(current, recomputed, {});
      expect(merged.fields.bbl_distribution).toBe(100);
      expect(merged.fields.cents_tax_reduced).toBe(35_000);
    });

    it("keeps a manual entry and flows it back through the whole form", () => {
      const current = { fields: { ...recomputed.fields, bbl_exports_without_tax: 20, cents_interest: 500 } };
      const merged = t.mergeWorksheet(current, recomputed, {});
      expect(merged.fields.bbl_exports_without_tax).toBe(20);
      // The preserved export must reach line 8, line 37, line 43 and line 29.
      expect(merged.fields.bbl_total_taxable).toBe(80);
      expect(merged.fields.cents_tax_reduced).toBe(28_000);
      expect(merged.fields.bbl_removals_without_tax_total).toBe(20);
      expect(merged.fields.bbl_produced).toBe(100);
      expect(merged.fields.bbl_ending).toBe(0);
      // ...and the preserved interest must reach line 23 and line 15.
      expect(merged.fields.cents_increasing_adjustments).toBe(500);
      expect(merged.fields.cents_amount_due).toBe(28_500);
    });

    it("carries the recompute's warnings and meta, not the stale ones", () => {
      const current = { fields: recomputed.fields, warnings: ["stale"], meta: { computedAt: "old" } };
      const merged = t.mergeWorksheet(current, { ...recomputed, warnings: ["fresh"] }, {});
      expect(merged.warnings).toEqual(["fresh"]);
      expect(merged.meta).toEqual({ computedAt: "2026-10-01T00:00:00.000Z" });
    });
  });

  describe("buildReferenceView", () => {
    it("shows the live configured rate on the reduced-rate line", () => {
      const ref = t.buildReferenceView({ [TAX_RATE_KEYS.FEDERAL_BEER_EXCISE]: 3.5 });
      expect(ref.tables[0].rows[0][0]).toBe("$3.50 per barrel");
    });

    it("leaves the $16.00 and $18.00 statutory tiers alone", () => {
      const ref = t.buildReferenceView({ [TAX_RATE_KEYS.FEDERAL_BEER_EXCISE]: 4.25 });
      expect(ref.tables[0].rows[0][0]).toBe("$4.25 per barrel");
      expect(ref.tables[0].rows[1][0]).toBe("$16.00 per barrel");
      expect(ref.tables[0].rows[2][0]).toBe("$18.00 per barrel");
    });

    it("falls back to the statutory text when no rate row is configured", () => {
      expect(t.buildReferenceView({}).tables[0].rows[0][0]).toBe("$3.50 per barrel");
    });
  });
});

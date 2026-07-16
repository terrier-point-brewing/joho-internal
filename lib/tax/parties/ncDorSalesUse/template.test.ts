import { describe, it, expect } from "vitest";
import type { WorksheetData } from "@/lib/tax/types";
import { ncDorSalesUseTemplate, resolveFieldOwnership } from "./template";
import { computeNcDorFigures } from "./calc";

// Seeded to mirror the OLD hardcoded constants (NC_STATE_RATE / RATE_BY_LINE /
// NC_COUNTY_TIERS) so parity assertions below are unchanged from before the
// rateMap refactor.
const RATE_MAP: Record<string, number> = {
  nc_sales_state: 0.0475,
  nc_sales_line_4: 0.0475,
  nc_sales_line_5: 0.03,
  nc_sales_line_6: 0.0475,
  nc_sales_line_7: 0.0475,
  nc_sales_line_8: 0.02,
  nc_sales_line_9: 0.02,
  nc_sales_line_10: 0.0225,
  nc_sales_line_11: 0.005,
  nc_sales_line_12: 0.0025,
  nc_local_WAKE: 0.02,
  nc_transit_WAKE: 0.005,
};

describe("ncDorSalesUseTemplate.computePeriod", () => {
  it("monthly: period = calendar month, due = 20th of the following month", () => {
    const ref = new Date(Date.UTC(2026, 5, 15, 12)); // June 15, 2026
    const period = ncDorSalesUseTemplate.computePeriod("monthly", ref);
    expect(period).toEqual({ start: "2026-06-01", end: "2026-06-30", due: "2026-07-20" });
  });

  it("monthly: December rolls the due date into January of the next year", () => {
    const ref = new Date(Date.UTC(2026, 11, 10, 12)); // Dec 10, 2026
    const period = ncDorSalesUseTemplate.computePeriod("monthly", ref);
    expect(period).toEqual({ start: "2026-12-01", end: "2026-12-31", due: "2027-01-20" });
  });

  it("quarterly: period = calendar quarter (Q2), due = last day of the following month", () => {
    const ref = new Date(Date.UTC(2026, 5, 15, 12)); // still Q2 (Apr-Jun)
    const period = ncDorSalesUseTemplate.computePeriod("quarterly", ref);
    expect(period).toEqual({ start: "2026-04-01", end: "2026-06-30", due: "2026-07-31" });
  });

  it("throws for an unsupported frequency", () => {
    expect(() => ncDorSalesUseTemplate.computePeriod("annual", new Date())).toThrow(
      /nc_dor_sales_use/,
    );
  });
});

describe("ncDorSalesUseTemplate.defaultDueRule", () => {
  it("monthly: due the 20th of the following month", () => {
    expect(ncDorSalesUseTemplate.defaultDueRule("monthly")).toEqual({ monthOffset: 1, day: 20 });
  });

  it("quarterly: due the last day of the following month", () => {
    expect(ncDorSalesUseTemplate.defaultDueRule("quarterly")).toEqual({ monthOffset: 1, day: "last" });
  });

  it("throws for an unsupported frequency", () => {
    expect(() => ncDorSalesUseTemplate.defaultDueRule("annual")).toThrow(/nc_dor_sales_use/);
  });
});

describe("resolveFieldOwnership", () => {
  it.each<[string, "computed" | "manual"]>([
    ["line1_gross_receipts", "computed"],
    ["line13_total", "computed"],
    ["line15_total", "computed"],
    ["line21_total_due", "computed"],
    ["line2_sales_for_resale", "manual"],
    ["line3_exempt", "manual"],
    ["line14_excess", "manual"],
    ["line16_penalty", "manual"],
    ["line17_interest", "manual"],
    ["line18_less_prepay", "manual"],
    ["line19_prepay_next", "manual"],
    ["line20_credit", "manual"],
    ["line20_credit_explanation", "manual"],
    ["line9_receipts", "computed"],
    ["line9_tax", "computed"],
    ["line9_purchases", "manual"],
    ["line12_tax", "computed"],
    ["county_WAKE_2pct", "computed"],
    ["county_DURHAM_transit", "computed"],
    ["county_MECKLENBURG_225pct", "computed"],
  ])("%s -> %s", (key, expected) => {
    expect(resolveFieldOwnership(key)).toBe(expected);
  });

  it("is reachable through fieldOwnership index access on the template", () => {
    expect(ncDorSalesUseTemplate.fieldOwnership.line1_gross_receipts).toBe("computed");
    expect(ncDorSalesUseTemplate.fieldOwnership.line16_penalty).toBe("manual");
    expect(ncDorSalesUseTemplate.fieldOwnership.county_WAKE_2pct).toBe("computed");
  });
});

describe("ncDorSalesUseTemplate.mergeWorksheet", () => {
  it("preserves a manual line16_penalty while overwriting computed line1_gross_receipts, re-deriving line21", () => {
    // Fresh Square compute (Wake, 100000 base) → line4 4750, line9 2000, line11 500.
    const base = computeNcDorFigures(
      {
        taxableBaseCents: 100000,
        counties: [{ code: "WAKE", weight: 100 }],
        collectedGeneralTaxCents: 7250,
      },
      RATE_MAP,
    );
    const recomputed: WorksheetData = {
      fields: base.fields,
      warnings: ["reconciliation note"],
      meta: { computedAt: "2026-07-12T00:00:00Z", provenance: "square" },
    };
    // What's currently saved: same shape, but a stale computed line1 and a
    // manual penalty the user entered.
    const current: WorksheetData = {
      fields: { ...base.fields, line1_gross_receipts: 999999, line16_penalty: 250 },
    };

    const merged = ncDorSalesUseTemplate.mergeWorksheet(current, recomputed, RATE_MAP);

    expect(merged.fields.line1_gross_receipts).toBe(100000); // computed -> overwritten
    expect(merged.fields.line16_penalty).toBe(250); // manual -> preserved
    expect(merged.fields.line4_tax).toBe(4750); // computed -> re-derived
    expect(merged.fields.line9_tax).toBe(2000);
    expect(merged.fields.line13_total).toBe(7250);
    expect(merged.fields.line21_total_due).toBe(7500); // 7250 + manual 250 penalty
    expect(merged.warnings).toEqual(["reconciliation note"]);
    expect(merged.meta).toEqual({ computedAt: "2026-07-12T00:00:00Z", provenance: "square" });
  });

  it("flows a preserved manual lineN_purchases into the re-derived line tax and Total Due", () => {
    const base = computeNcDorFigures(
      {
        taxableBaseCents: 100000,
        counties: [{ code: "WAKE", weight: 100 }],
        collectedGeneralTaxCents: 7250,
      },
      RATE_MAP,
    );
    const recomputed: WorksheetData = { fields: base.fields };
    // The user had entered a Purchases-for-Use on line 9 before recomputing.
    const current: WorksheetData = { fields: { ...base.fields, line9_purchases: 50000 } };

    const merged = ncDorSalesUseTemplate.mergeWorksheet(current, recomputed, RATE_MAP);

    expect(merged.fields.line9_purchases).toBe(50000); // manual -> preserved
    expect(merged.fields.line9_tax).toBe(3000); // round((50000+100000)×0.02)
    expect(merged.fields.county_WAKE_2pct).toBe(3000); // reconciles
    expect(merged.fields.line13_total).toBe(8250);
    expect(merged.fields.line21_total_due).toBe(8250);
  });

  it("falls back to the recomputed value for a manual field with no current value yet", () => {
    const current: WorksheetData = { fields: {} };
    const recomputed: WorksheetData = { fields: { line1_gross_receipts: 5000, line16_penalty: 0 } };
    const merged = ncDorSalesUseTemplate.mergeWorksheet(current, recomputed, RATE_MAP);
    expect(merged.fields.line16_penalty).toBe(0);
    expect(merged.fields.line1_gross_receipts).toBe(5000);
  });

  it("an empty rateMap zeroes every re-derived tax (regression guard against ignoring the map)", () => {
    const base = computeNcDorFigures(
      {
        taxableBaseCents: 100000,
        counties: [{ code: "WAKE", weight: 100 }],
        collectedGeneralTaxCents: 7250,
      },
      RATE_MAP,
    );
    const merged = ncDorSalesUseTemplate.mergeWorksheet({ fields: base.fields }, { fields: base.fields }, {});
    expect(merged.fields.line4_tax).toBe(0);
    expect(merged.fields.line13_total).toBe(0);
  });
});

describe("template shape", () => {
  it("declares the NC DOR party identity and frequencies", () => {
    expect(ncDorSalesUseTemplate.key).toBe("nc_dor_sales_use");
    expect(ncDorSalesUseTemplate.label).toBe("NC DOR — Sales & Use Tax");
    expect(ncDorSalesUseTemplate.supportedFrequencies).toEqual(["monthly", "quarterly"]);
    expect(ncDorSalesUseTemplate.recomputeLabel).toBe("Recompute from Square");
    expect(ncDorSalesUseTemplate.worksheetComponent).toBe("nc_dor_sales_use");
  });

  it("settingsSchema is trimmed to only the party-specific Square tax mapping field", () => {
    expect(ncDorSalesUseTemplate.settingsSchema.map((f) => f.key)).toEqual(["general_sales_tax_id"]);
  });

  it("scheduleConfigSchema exposes a counties field with NC county options", () => {
    const counties = ncDorSalesUseTemplate.scheduleConfigSchema.find((f) => f.key === "counties");
    expect(counties?.options?.length).toBe(100);
    expect(counties?.options?.some((o) => o.label === "Wake")).toBe(true);
  });

  it("buildReferenceView(rateMap) includes state rate, county tier chart, and period/due notes", () => {
    const { tables, notes } = ncDorSalesUseTemplate.buildReferenceView(RATE_MAP);
    expect(tables.some((t) => /state rate/i.test(t.title))).toBe(true);
    const stateTable = tables.find((t) => /state rate/i.test(t.title));
    expect(stateTable?.rows[0][0]).toBe("4.75%");
    const countyTable = tables.find((t) => /county/i.test(t.title));
    expect(countyTable?.rows.length).toBe(100);
    const wakeRow = countyTable?.rows.find((r) => r[0] === "Wake");
    expect(wakeRow).toEqual(["Wake", "2.00%", "0.50%", "2.50%"]);
    expect(notes?.some((n) => /20th/.test(n))).toBe(true);
  });
});

describe("registry wiring", () => {
  it("registers nc_dor_sales_use through lib/tax/parties side-effect import", async () => {
    await import("@/lib/tax/parties");
    const { getParty } = await import("@/lib/tax/registry");
    const party = getParty("nc_dor_sales_use");
    expect(party.key).toBe("nc_dor_sales_use");
    expect(party).toBe(ncDorSalesUseTemplate);
  });
});

describe("ncDorSalesUseTemplate.requiredRegistrations", () => {
  it("requires the NC DOR account # (shared with beer excise, not its own separate registration)", () => {
    expect(ncDorSalesUseTemplate.requiredRegistrations).toEqual([
      { authorityKey: "nc_dor", registrationKey: "nc_dor_account_id", label: "NC DOR Account / License Number" },
    ]);
  });
});

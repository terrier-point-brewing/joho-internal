import { describe, it, expect } from "vitest";
import type { WorksheetData } from "@/lib/tax/types";
import { ncDorSalesUseTemplate, resolveFieldOwnership } from "./template";

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
    const current: WorksheetData = {
      fields: {
        line1_gross_receipts: 999999, // stale computed value
        line4_tax: 4750,
        line9_tax: 2000,
        line11_tax: 500,
        line16_penalty: 250, // manual edit the user made
        line14_excess: 0,
        line17_interest: 0,
        line18_less_prepay: 0,
        line19_prepay_next: 0,
        line20_credit: 0,
      },
    };
    const recomputed: WorksheetData = {
      fields: {
        line1_gross_receipts: 100000, // fresh computed value
        line4_tax: 4750,
        line9_tax: 2000,
        line11_tax: 500,
        line16_penalty: 0, // a fresh recompute always resets penalty to 0
        line14_excess: 0,
        line17_interest: 0,
        line18_less_prepay: 0,
        line19_prepay_next: 0,
        line20_credit: 0,
      },
      warnings: ["reconciliation note"],
      meta: { computedAt: "2026-07-12T00:00:00Z", provenance: "square" },
    };

    const merged = ncDorSalesUseTemplate.mergeWorksheet(current, recomputed);

    expect(merged.fields.line1_gross_receipts).toBe(100000); // computed -> overwritten
    expect(merged.fields.line16_penalty).toBe(250); // manual -> preserved
    expect(merged.fields.line13_total).toBe(7250);
    expect(merged.fields.line21_total_due).toBe(7500); // 7250 + manual 250 penalty
    expect(merged.warnings).toEqual(["reconciliation note"]);
    expect(merged.meta).toEqual({ computedAt: "2026-07-12T00:00:00Z", provenance: "square" });
  });

  it("falls back to the recomputed value for a manual field with no current value yet", () => {
    const current: WorksheetData = { fields: {} };
    const recomputed: WorksheetData = { fields: { line1_gross_receipts: 5000, line16_penalty: 0 } };
    const merged = ncDorSalesUseTemplate.mergeWorksheet(current, recomputed);
    expect(merged.fields.line16_penalty).toBe(0);
    expect(merged.fields.line1_gross_receipts).toBe(5000);
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

  it("settingsSchema requires fein and marks ssn sensitive/optional", () => {
    const fein = ncDorSalesUseTemplate.settingsSchema.find((f) => f.key === "fein");
    const ssn = ncDorSalesUseTemplate.settingsSchema.find((f) => f.key === "ssn");
    expect(fein?.required).toBe(true);
    expect(ssn?.sensitive).toBe(true);
    expect(ssn?.required).toBeFalsy();
  });

  it("scheduleConfigSchema exposes a counties field with NC county options", () => {
    const counties = ncDorSalesUseTemplate.scheduleConfigSchema.find((f) => f.key === "counties");
    expect(counties?.options?.length).toBe(100);
    expect(counties?.options?.some((o) => o.label === "Wake")).toBe(true);
  });

  it("referenceView includes state rate, county tier chart, and period/due notes", () => {
    const { tables, notes } = ncDorSalesUseTemplate.referenceView;
    expect(tables.some((t) => /state rate/i.test(t.title))).toBe(true);
    const countyTable = tables.find((t) => /county/i.test(t.title));
    expect(countyTable?.rows.length).toBe(100);
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

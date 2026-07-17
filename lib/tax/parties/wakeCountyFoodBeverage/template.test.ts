import { describe, it, expect } from "vitest";
import { wakeCountyFoodBeverageTemplate as t } from "./template";

describe("wakeCountyFoodBeverageTemplate", () => {
  it("declares monthly cadence due the 20th of the following month", () => {
    expect(t.supportedFrequencies).toEqual(["monthly"]);
    expect(t.defaultDueRule("monthly")).toEqual({ monthOffset: 1, day: 20 });
    const p = t.computePeriod("monthly", new Date("2026-07-15T12:00:00Z"));
    expect(p.start).toBe("2026-07-01");
    expect(p.end).toBe("2026-07-31");
    expect(p.due).toBe("2026-08-20");
  });

  it("rejects unsupported frequencies", () => {
    expect(() => t.defaultDueRule("quarterly")).toThrow();
  });

  it("declares the required Wake County account registration", () => {
    expect(t.requiredRegistrations).toContainEqual({
      authorityKey: "wake_county",
      registrationKey: "wake_county_account_id",
      label: "Wake County Gross Receipts Account Number",
    });
  });

  it("exposes the two Square-tax selects and the sensitive PIN in settingsSchema", () => {
    const keys = t.settingsSchema.map((f) => f.key);
    expect(keys).toEqual(["food_beverage_tax_id", "general_sales_tax_id", "filing_pin"]);
    const fb = t.settingsSchema.find((f) => f.key === "food_beverage_tax_id");
    expect(fb?.type).toBe("select");
    expect(fb?.required).toBe(true);
    const pin = t.settingsSchema.find((f) => f.key === "filing_pin");
    expect(pin?.type).toBe("text");
    expect(pin?.sensitive).toBe(true);
  });

  it("mergeWorksheet fully replaces fields with the recompute (all fields computed)", () => {
    const current = { fields: { wake_tax_owed_cents: 111, stray: "keep?" } };
    const recomputed = { fields: { wake_tax_owed_cents: 222 }, meta: { computedAt: "t" } };
    const merged = t.mergeWorksheet(current, recomputed, {});
    expect(merged.fields).toEqual({ wake_tax_owed_cents: 222 });
  });

  it("buildReferenceView renders the live rate when present", () => {
    const ref = t.buildReferenceView({ wake_county_food_beverage_tax: 0.01 });
    expect(ref.tables[0].rows[0][0]).toBe("1.00%");
  });
});

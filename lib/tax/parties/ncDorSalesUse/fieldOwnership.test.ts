import { describe, it, expect } from "vitest";
import { resolveFieldOwnership, isComputedField } from "./fieldOwnership";

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
    ["some_unrecognized_key", "manual"],
  ])("%s -> %s", (key, expected) => {
    expect(resolveFieldOwnership(key)).toBe(expected);
  });
});

describe("isComputedField", () => {
  it("mirrors resolveFieldOwnership === 'computed'", () => {
    expect(isComputedField("line1_gross_receipts")).toBe(true);
    expect(isComputedField("line16_penalty")).toBe(false);
    expect(isComputedField("county_WAKE_2pct")).toBe(true);
    expect(isComputedField("line9_purchases")).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { adjustmentCost, sumAdjustmentCost, type CostAdjustmentRow } from "./cogs";

const row = (over: Partial<CostAdjustmentRow>): CostAdjustmentRow => ({
  total_value_change: null,
  cost_per_unit: null,
  quantity: null,
  ...over,
});

describe("adjustmentCost", () => {
  it("prefers the recorded decimal-dollar total_value_change", () => {
    // 12.50 dollars — NOT cents. If someone treated this as cents it would be 0.125.
    expect(adjustmentCost(row({ total_value_change: -12.5, quantity: 3, cost_per_unit: 99 }))).toBe(12.5);
  });

  it("returns a positive magnitude for negative (consumption/waste) value changes", () => {
    expect(adjustmentCost(row({ total_value_change: -40 }))).toBe(40);
    expect(adjustmentCost(row({ total_value_change: 40 }))).toBe(40);
  });

  it("falls back to quantity × cost_per_unit only when total_value_change is null", () => {
    expect(adjustmentCost(row({ quantity: 4, cost_per_unit: 2.25 }))).toBe(9);
  });

  it("does not fall back when total_value_change is zero", () => {
    expect(adjustmentCost(row({ total_value_change: 0, quantity: 4, cost_per_unit: 2.25 }))).toBe(0);
  });

  it("treats a null cost_per_unit in the fallback as zero cost", () => {
    expect(adjustmentCost(row({ quantity: 10, cost_per_unit: null }))).toBe(0);
  });

  it("treats a null quantity in the fallback as zero cost", () => {
    expect(adjustmentCost(row({ quantity: null, cost_per_unit: 5 }))).toBe(0);
  });

  it("keeps decimal-dollar precision (no cents conversion at this seam)", () => {
    // Guard: a stray ×100 or ÷100 here would break the dollar arithmetic.
    expect(adjustmentCost(row({ total_value_change: -3.33 }))).toBe(3.33);
  });
});

describe("sumAdjustmentCost", () => {
  it("returns 0 for an empty list", () => {
    expect(sumAdjustmentCost([])).toBe(0);
  });

  it("sums mixed recorded and fallback rows as positive dollar magnitudes", () => {
    const rows: CostAdjustmentRow[] = [
      row({ total_value_change: -12.5 }),        // recorded, consumption
      row({ quantity: 4, cost_per_unit: 2.25 }), // fallback → 9
      row({ total_value_change: 8 }),            // recorded, positive
    ];
    expect(sumAdjustmentCost(rows)).toBeCloseTo(29.5, 10);
  });
});

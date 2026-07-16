import { describe, it, expect } from "vitest";
import { computeReceivedAdjustment } from "./receivedAdjustment";

describe("computeReceivedAdjustment", () => {
  it("bakes shipping into landed cost and recomputes weighted-average cost", () => {
    const result = computeReceivedAdjustment({
      currentStock: 100,
      currentCostPerUnit: 2.0,
      quantity: 50,
      purchaseCost: 2.5,
      shippingCost: 25,
    });
    expect(result.landedCostPerUnit).toBe(3.0);
    expect(result.newStock).toBe(150);
    expect(result.newCostPerUnit).toBeCloseTo(2.333333, 5);
  });

  it("treats a null currentCostPerUnit as 0 (brand-new item)", () => {
    const result = computeReceivedAdjustment({
      currentStock: 0,
      currentCostPerUnit: null,
      quantity: 20,
      purchaseCost: 5.0,
      shippingCost: 10,
    });
    expect(result.landedCostPerUnit).toBe(5.5);
    expect(result.newStock).toBe(20);
    expect(result.newCostPerUnit).toBe(5.5);
  });

  it("landed cost equals purchase cost when shipping is 0", () => {
    const result = computeReceivedAdjustment({
      currentStock: 10,
      currentCostPerUnit: 1.0,
      quantity: 10,
      purchaseCost: 2.0,
      shippingCost: 0,
    });
    expect(result.landedCostPerUnit).toBe(2.0);
    expect(result.newStock).toBe(20);
    expect(result.newCostPerUnit).toBe(1.5);
  });
});

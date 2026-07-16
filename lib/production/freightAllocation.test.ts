import { describe, it, expect } from "vitest";
import { allocateFreightByWeight } from "./freightAllocation";

describe("allocateFreightByWeight", () => {
  it("returns [] for no lines", () => {
    expect(allocateFreightByWeight([], 100)).toEqual([]);
  });

  it("splits proportional to quantity when all lines share the same known unit", () => {
    const result = allocateFreightByWeight(
      [{ unit: "lbs", quantity: 10 }, { unit: "lbs", quantity: 30 }],
      40
    );
    expect(result).toEqual([10, 30]);
  });

  it("splits by true weight (not raw quantity) across mixed known units", () => {
    const result = allocateFreightByWeight(
      [{ unit: "lb", quantity: 10 }, { unit: "oz", quantity: 16 }],
      17.6
    );
    expect(result).toEqual([16, 1.6]);
  });

  it("treats an unmatched unit as equivalent to the batch's majority matched unit", () => {
    const result = allocateFreightByWeight(
      [
        { unit: "lbs", quantity: 10 },
        { unit: "lbs", quantity: 10 },
        { unit: "bricks", quantity: 5 },
      ],
      40
    );
    expect(result).toEqual([16, 16, 8]);
  });

  it("falls back to raw-quantity proportioning when no line matches a known unit", () => {
    const result = allocateFreightByWeight(
      [{ unit: "bricks", quantity: 10 }, { unit: "cases", quantity: 30 }],
      40
    );
    expect(result).toEqual([10, 30]);
  });

  it("breaks a majority-unit tie deterministically by first occurrence", () => {
    // "oz" and "lb" both matched once each -> tie -> "oz" wins (appears first).
    // bricks (unmatched) is then treated as 1 brick = 1 oz.
    const result = allocateFreightByWeight(
      [
        { unit: "oz", quantity: 5 },
        { unit: "lb", quantity: 2 },
        { unit: "bricks", quantity: 3 },
      ],
      40
    );
    expect(result).toEqual([5, 32, 3]);
  });

  it("distributes leftover cents to the lowest-index line on an exact tie", () => {
    const result = allocateFreightByWeight(
      [
        { unit: "lb", quantity: 1 },
        { unit: "lb", quantity: 1 },
        { unit: "lb", quantity: 1 },
      ],
      10
    );
    expect(result).toEqual([3.34, 3.33, 3.33]);
    expect(result.reduce((s, n) => s + n, 0)).toBeCloseTo(10, 2);
  });
});

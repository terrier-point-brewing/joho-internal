import { describe, it, expect } from "vitest";
import { validateCountyWeights, type CountyWeight } from "./scheduleConfig";

describe("validateCountyWeights", () => {
  it("errors on an empty county list", () => {
    expect(validateCountyWeights([])).toBe("Select at least one county.");
  });

  it("errors when weights don't sum to 100", () => {
    const counties: CountyWeight[] = [
      { code: "WAKE", weight: 60 },
      { code: "DURHAM", weight: 30 },
    ];
    expect(validateCountyWeights(counties)).toBe(
      "County weights must sum to 100% (currently 90.00%).",
    );
  });

  it("returns null when weights sum to exactly 100", () => {
    const counties: CountyWeight[] = [
      { code: "WAKE", weight: 70 },
      { code: "DURHAM", weight: 30 },
    ];
    expect(validateCountyWeights(counties)).toBeNull();
  });

  it("accepts a sum within floating-point tolerance of 100", () => {
    const counties: CountyWeight[] = [
      { code: "WAKE", weight: 33.34 },
      { code: "DURHAM", weight: 33.33 },
      { code: "ORANGE", weight: 33.33 },
    ];
    expect(validateCountyWeights(counties)).toBeNull();
  });

  it("errors on a negative weight", () => {
    const counties: CountyWeight[] = [
      { code: "WAKE", weight: 120 },
      { code: "DURHAM", weight: -20 },
    ];
    expect(validateCountyWeights(counties)).toBe(
      "Weight for DURHAM must be a non-negative number.",
    );
  });

  it("errors on a non-finite weight", () => {
    const counties: CountyWeight[] = [{ code: "WAKE", weight: NaN }];
    expect(validateCountyWeights(counties)).toBe(
      "Weight for WAKE must be a non-negative number.",
    );
  });

  it("a single county at 100% is valid", () => {
    expect(validateCountyWeights([{ code: "WAKE", weight: 100 }])).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import {
  BBL_TO_FL_OZ,
  FL_OZ_PER_GALLON,
  GALLONS_PER_BBL,
  KEG_FL_OZ_BY_SIZE,
  KEG_GALLONS_BY_SIZE,
} from "./production";
import { volumeFlOzPerUnit } from "@/lib/square/catalogUnits";

// One physical container, one capacity. These assertions exist because the app
// once carried three different numbers for a sixtel at the same time: 660 on
// tap_assignments, 661 on packaging_variations, and 661.376 here (the old
// hard-coded 5.167 gal). The first two are database problems; this file guards
// the third, which is the only one TypeScript can hold on its own.
describe("keg volume constants", () => {
  it("derives gallons from fl oz, so the two can never disagree", () => {
    for (const size of ["half", "quarter", "sixth"] as const) {
      expect(KEG_GALLONS_BY_SIZE[size] * FL_OZ_PER_GALLON).toBe(KEG_FL_OZ_BY_SIZE[size]);
    }
  });

  it("still reports the conventional half and quarter gallon figures", () => {
    expect(KEG_GALLONS_BY_SIZE.half).toBe(15.5);
    expect(KEG_GALLONS_BY_SIZE.quarter).toBe(7.75);
  });

  it("keeps the sixtel within a tenth of a gallon of a true sixth barrel", () => {
    // 31/6 gal = 661.33 fl oz; we store whole ounces, so a small gap is expected
    // and accepted — what is not accepted is two different roundings coexisting.
    const trueSixth = GALLONS_PER_BBL / 6;
    expect(Math.abs(KEG_GALLONS_BY_SIZE.sixth - trueSixth)).toBeLessThan(0.1);
  });

  it("agrees with the Square variation-name parser", () => {
    expect(volumeFlOzPerUnit("1/2 Keg")).toBe(KEG_FL_OZ_BY_SIZE.half);
    expect(volumeFlOzPerUnit("1/4 Keg")).toBe(KEG_FL_OZ_BY_SIZE.quarter);
    expect(volumeFlOzPerUnit("1/6 Keg")).toBe(KEG_FL_OZ_BY_SIZE.sixth);
  });

  it("keeps the barrel conversion consistent with the gallon constant", () => {
    expect(GALLONS_PER_BBL * FL_OZ_PER_GALLON).toBe(BBL_TO_FL_OZ);
  });
});

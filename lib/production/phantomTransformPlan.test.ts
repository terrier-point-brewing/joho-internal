import { describe, it, expect } from "vitest";
import { planTransform } from "./phantomTransformPlan";

const CASE_24 = 384; // 24 x 16 fl oz
const CAN_16 = 16;
const HALF_KEG = 1984;
const SIXTEL = 661;

function base(over: Partial<Parameters<typeof planTransform>[0]> = {}) {
  return planTransform({
    lotId: "lot-1",
    lotVariationId: "case",
    lotVariationName: "Case (24)",
    lotVolumeFlOz: CASE_24,
    onHand: 3,
    batchId: "batch-1",
    batchCode: "B-001",
    targetVariationId: "can",
    targetVariationName: "16 oz Can",
    targetVolumeFlOz: CAN_16,
    unitsNeeded: 1,
    ...over,
  });
}

describe("planTransform", () => {
  it("breaks one case for a single can, and the whole case is broken", () => {
    const plan = base();
    // The physical act is cracking a case, not extracting one can from it.
    expect(plan).toMatchObject({ fromUnits: 1, toUnits: 24, lossless: true, shrinkageFlOz: 0 });
  });

  it("takes only as many parents as the need requires", () => {
    expect(base({ unitsNeeded: 25 })).toMatchObject({ fromUnits: 2, toUnits: 48 });
  });

  it("never proposes more output than the honest whole-unit ratio", () => {
    // The DB's rounding slack scales with output count and would tolerate 25
    // cans from a 24-can case. Planning must not reach for that.
    expect(base({ unitsNeeded: 24 })).toMatchObject({ fromUnits: 1, toUnits: 24 });
  });

  it("records the real loss when kegs are broken down", () => {
    const plan = base({
      lotVariationId: "half",
      lotVariationName: "1/2 Keg",
      lotVolumeFlOz: HALF_KEG,
      targetVariationId: "sixtel",
      targetVariationName: "1/6 Keg",
      targetVolumeFlOz: SIXTEL,
    });
    expect(plan).toMatchObject({ fromUnits: 1, toUnits: 3, lossless: true });
  });

  it("returns null when the lot cannot cover the need", () => {
    expect(base({ unitsNeeded: 100, onHand: 3 })).toBeNull();
  });

  it("returns null when the lot is smaller than what was booked", () => {
    expect(base({ lotVolumeFlOz: CAN_16, targetVolumeFlOz: CASE_24 })).toBeNull();
  });

  it("returns null when the lot is already the booked variation", () => {
    expect(base({ lotVariationId: "can" })).toBeNull();
  });

  it("returns null without a resolvable target", () => {
    expect(base({ targetVariationId: "" })).toBeNull();
  });
});

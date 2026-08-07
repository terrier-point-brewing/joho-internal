import { describe, it, expect } from "vitest";
import { previewTransform, roundingSlackFlOz } from "./coldStorageTransform";

// Real volumes from packaging_variations: a 1/2 bbl keg is 15.5 gal = 1984 fl
// oz, a 1/6 bbl is 5.16 gal = 661 fl oz, a 1/4 bbl is 992.
//
// 1984 and 992 are exact. 661 is NOT — a 1/6 bbl is really 661.33 fl oz and the
// column stores whole ounces — which is the whole reason for the rounding slack
// these tests keep poking at.
const HALF = 1984;
const SIXTH = 661;
const QUARTER = 992;

describe("previewTransform — breaking down", () => {
  it("three sixtels from a half keg is a near-perfect run", () => {
    const p = previewTransform({ fromUnits: 1, fromVolumeFlOz: HALF, toUnits: 3, toVolumeFlOz: SIXTH });
    expect(p.volumeOutFlOz).toBe(1983);
    expect(p.shrinkageFlOz).toBe(1); // the 1 oz the stored sizes don't quite line up on
    expect(p.withinRoundingSlack).toBe(true); // …and it's rounding, not beer
    expect(p.createsVolume).toBe(false);
  });

  it("two sixtels from a half keg loses a third of the keg", () => {
    const p = previewTransform({ fromUnits: 1, fromVolumeFlOz: HALF, toUnits: 2, toVolumeFlOz: SIXTH });
    expect(p.shrinkageFlOz).toBe(662);
    expect(p.shrinkageBbl).toBeCloseTo(0.167, 3);
    expect(p.shrinkageRatio).toBeCloseTo(1 / 3, 2);
    expect(p.withinRoundingSlack).toBe(false); // 662 fl oz is beer, not arithmetic
    expect(p.createsVolume).toBe(false);
  });

  it("caps a half keg at three sixtels", () => {
    const p = previewTransform({ fromUnits: 1, fromVolumeFlOz: HALF, toUnits: 2, toVolumeFlOz: SIXTH });
    expect(p.maxToUnits).toBe(3);
  });
});

describe("previewTransform — building up", () => {
  // The motivating case. An Epic Hazy 1/2 Keg sale booked a phantom export with
  // no half keg in cold storage to deduct — only sixtels. Combining three of
  // them is the operator's route to a reconcilable lot, and the pre-slack
  // constraint rejected it by a single fluid ounce.
  it("combines three sixtels into a half keg", () => {
    const p = previewTransform({ fromUnits: 3, fromVolumeFlOz: SIXTH, toUnits: 1, toVolumeFlOz: HALF });
    expect(p.volumeInFlOz).toBe(1983);
    expect(p.volumeOutFlOz).toBe(1984);
    expect(p.shrinkageFlOz).toBe(-1); // stored rounding showing through, not beer
    expect(p.roundingSlackFlOz).toBe(2); // 4 units x 0.5
    expect(p.withinRoundingSlack).toBe(true);
    expect(p.createsVolume).toBe(false);
    expect(p.maxToUnits).toBe(1);
  });

  it("combines three sixtels into two quarters — the same 1 oz gap", () => {
    const p = previewTransform({ fromUnits: 3, fromVolumeFlOz: SIXTH, toUnits: 2, toVolumeFlOz: QUARTER });
    expect(p.shrinkageFlOz).toBe(-1);
    expect(p.createsVolume).toBe(false);
    expect(p.maxToUnits).toBe(2);
  });

  it("scales: ten half kegs from thirty sixtels, a 10 oz gap", () => {
    // The point of a per-unit slack. This is the motivating case ten times over
    // and the rounding shortfall is ten times bigger; a flat tolerance of 5 would
    // pass the small one and reject this, which would be incoherent.
    const p = previewTransform({ fromUnits: 30, fromVolumeFlOz: SIXTH, toUnits: 10, toVolumeFlOz: HALF });
    expect(p.shrinkageFlOz).toBe(-10);
    expect(p.roundingSlackFlOz).toBe(20);
    expect(p.createsVolume).toBe(false);
    expect(p.maxToUnits).toBe(10);
  });

  it("two quarters into a half keg is exact and needs no slack", () => {
    const p = previewTransform({ fromUnits: 2, fromVolumeFlOz: QUARTER, toUnits: 1, toVolumeFlOz: HALF });
    expect(p.shrinkageFlOz).toBe(0);
    expect(p.withinRoundingSlack).toBe(true);
    expect(p.createsVolume).toBe(false);
  });

  it("records real loss on a build-up too — beer is lost combining kegs", () => {
    // Four sixtels (2644) into one half keg (1984): 660 fl oz left in the lines
    // and the foam. Shrinkage is not a break-down-only idea.
    const p = previewTransform({ fromUnits: 4, fromVolumeFlOz: SIXTH, toUnits: 1, toVolumeFlOz: HALF });
    expect(p.shrinkageFlOz).toBe(660);
    expect(p.withinRoundingSlack).toBe(false);
    expect(p.createsVolume).toBe(false);
  });
});

describe("previewTransform — refuses to invent beer", () => {
  it("flags a fourth sixtel from one half keg", () => {
    const p = previewTransform({ fromUnits: 1, fromVolumeFlOz: HALF, toUnits: 4, toVolumeFlOz: SIXTH });
    expect(p.createsVolume).toBe(true);
    expect(p.shrinkageFlOz).toBeLessThan(0);
  });

  it("flags two half kegs built from four sixtels", () => {
    // 4 x 661 = 2644 in, 2 x 1984 = 3968 out. A 1324 fl oz gain, nowhere near
    // the 3 fl oz of rounding six units earn. The slack must not save this.
    const p = previewTransform({ fromUnits: 4, fromVolumeFlOz: SIXTH, toUnits: 2, toVolumeFlOz: HALF });
    expect(p.shrinkageFlOz).toBe(-1324);
    expect(p.roundingSlackFlOz).toBe(3);
    expect(p.createsVolume).toBe(true);
    expect(p.maxToUnits).toBe(1);
  });

  it("flags a half keg built from a single quarter", () => {
    const p = previewTransform({ fromUnits: 1, fromVolumeFlOz: QUARTER, toUnits: 1, toVolumeFlOz: HALF });
    expect(p.createsVolume).toBe(true);
    expect(p.maxToUnits).toBe(0);
  });

  it("accepts an exact-fit transform without calling it a gain", () => {
    // 1 half keg -> 2 quarters is exactly 1984 fl oz. Float dust must not tip
    // this into createsVolume, or a legitimate transform gets blocked.
    const p = previewTransform({ fromUnits: 1, fromVolumeFlOz: HALF, toUnits: 2, toVolumeFlOz: QUARTER });
    expect(p.shrinkageFlOz).toBe(0);
    expect(p.createsVolume).toBe(false);
    expect(p.maxToUnits).toBe(2);
  });

  it("scales with multiple sources", () => {
    const p = previewTransform({ fromUnits: 2, fromVolumeFlOz: HALF, toUnits: 5, toVolumeFlOz: SIXTH });
    expect(p.volumeInFlOz).toBe(3968);
    expect(p.shrinkageFlOz).toBe(3968 - 3305);
    expect(p.maxToUnits).toBe(6);
    expect(p.createsVolume).toBe(false);
  });
});

describe("previewTransform — the slack is rounding and nothing more", () => {
  it("is half an ounce per unit, counting both sides", () => {
    expect(roundingSlackFlOz(1, 3)).toBe(2);
    expect(roundingSlackFlOz(3, 1)).toBe(2);
    expect(roundingSlackFlOz(30, 10)).toBe(20);
  });

  it("agrees exactly with maxToUnits at the boundary", () => {
    // maxToUnits is solved from the same inequality createsVolume tests, so the
    // cap must be the last count that passes and cap+1 the first that fails —
    // the UI can never offer something the DB would reject.
    const cases = [
      { fromUnits: 1, fromVolumeFlOz: HALF, toVolumeFlOz: SIXTH },
      { fromUnits: 3, fromVolumeFlOz: SIXTH, toVolumeFlOz: HALF },
      { fromUnits: 3, fromVolumeFlOz: SIXTH, toVolumeFlOz: QUARTER },
      { fromUnits: 30, fromVolumeFlOz: SIXTH, toVolumeFlOz: HALF },
      { fromUnits: 2, fromVolumeFlOz: QUARTER, toVolumeFlOz: HALF },
      { fromUnits: 1, fromVolumeFlOz: 384, toVolumeFlOz: 96 },
    ];
    for (const c of cases) {
      const cap = previewTransform({ ...c, toUnits: 1 }).maxToUnits;
      expect(previewTransform({ ...c, toUnits: cap }).createsVolume).toBe(false);
      expect(previewTransform({ ...c, toUnits: cap + 1 }).createsVolume).toBe(true);
    }
  });

  it("never covers a whole extra unit of any container we stock", () => {
    // The smallest thing in cold storage is a 12 oz can. Even a 20-unit
    // transform earns 10 fl oz of slack — less than one can, so the allowance
    // can never quietly conjure a sellable unit.
    expect(roundingSlackFlOz(10, 10)).toBeLessThan(12);
  });
});

describe("previewTransform — can breaks conserve", () => {
  it("reports zero shrinkage for a case cracked into six-packs", () => {
    // A 24-can case (384 fl oz of 16oz cans) into four 6-packs (96 fl oz each).
    const p = previewTransform({ fromUnits: 1, fromVolumeFlOz: 384, toUnits: 4, toVolumeFlOz: 96 });
    expect(p.shrinkageFlOz).toBe(0);
    expect(p.shrinkageRatio).toBe(0);
    expect(p.createsVolume).toBe(false);
  });
});

describe("previewTransform — degenerate input", () => {
  it("reports no ratio rather than NaN when nothing is being transformed", () => {
    const p = previewTransform({ fromUnits: 0, fromVolumeFlOz: HALF, toUnits: 0, toVolumeFlOz: SIXTH });
    expect(p.shrinkageRatio).toBe(0);
    expect(Number.isNaN(p.shrinkageRatio)).toBe(false);
  });

  it("reports no cap rather than Infinity when the target has no volume", () => {
    const p = previewTransform({ fromUnits: 1, fromVolumeFlOz: HALF, toUnits: 1, toVolumeFlOz: 0 });
    expect(p.maxToUnits).toBe(0);
    expect(Number.isFinite(p.maxToUnits)).toBe(true);
  });

  it("reports no cap for a target smaller than the slack itself", () => {
    // Guards the divide in maxToUnits: a sub-half-ounce container would flip the
    // denominator negative and hand back a nonsense cap.
    const p = previewTransform({ fromUnits: 1, fromVolumeFlOz: HALF, toUnits: 1, toVolumeFlOz: 0.25 });
    expect(p.maxToUnits).toBe(0);
  });
});

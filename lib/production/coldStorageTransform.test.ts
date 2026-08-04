import { describe, it, expect } from "vitest";
import { previewTransform } from "./coldStorageTransform";

// Real volumes from packaging_variations: a 1/2 bbl keg is 15.5 gal = 1984 fl
// oz, a 1/6 bbl is 5.16 gal = 661 fl oz, a 1/4 bbl is 992.
const HALF = 1984;
const SIXTH = 661;
const QUARTER = 992;

describe("previewTransform — the motivating case", () => {
  it("three sixtels from a half keg is a near-perfect run", () => {
    const p = previewTransform({ fromUnits: 1, fromVolumeFlOz: HALF, toUnits: 3, toVolumeFlOz: SIXTH });
    expect(p.producedVolumeFlOz).toBe(1983);
    expect(p.shrinkageFlOz).toBe(1); // the 1 oz the sizes don't quite line up on
    expect(p.createsVolume).toBe(false);
  });

  it("two sixtels from a half keg loses a third of the keg", () => {
    const p = previewTransform({ fromUnits: 1, fromVolumeFlOz: HALF, toUnits: 2, toVolumeFlOz: SIXTH });
    expect(p.shrinkageFlOz).toBe(662);
    expect(p.shrinkageBbl).toBeCloseTo(0.167, 3);
    expect(p.shrinkageRatio).toBeCloseTo(1 / 3, 2);
    expect(p.createsVolume).toBe(false);
  });

  it("caps a half keg at three sixtels", () => {
    const p = previewTransform({ fromUnits: 1, fromVolumeFlOz: HALF, toUnits: 2, toVolumeFlOz: SIXTH });
    expect(p.maxToUnits).toBe(3);
  });
});

describe("previewTransform — refuses to invent beer", () => {
  it("flags a fourth sixtel from one half keg", () => {
    const p = previewTransform({ fromUnits: 1, fromVolumeFlOz: HALF, toUnits: 4, toVolumeFlOz: SIXTH });
    expect(p.createsVolume).toBe(true);
    expect(p.shrinkageFlOz).toBeLessThan(0);
  });

  it("accepts an exact-fit transform without calling it a gain", () => {
    // 1 half keg -> 2 quarters is exactly 1984 fl oz. Float dust must not tip
    // this into createsVolume, or a legitimate transform gets blocked.
    const p = previewTransform({ fromUnits: 1, fromVolumeFlOz: HALF, toUnits: 2, toVolumeFlOz: QUARTER });
    expect(p.shrinkageFlOz).toBe(0);
    expect(p.createsVolume).toBe(false);
    expect(p.maxToUnits).toBe(2);
  });

  it("scales with multiple parents", () => {
    const p = previewTransform({ fromUnits: 2, fromVolumeFlOz: HALF, toUnits: 5, toVolumeFlOz: SIXTH });
    expect(p.sourceVolumeFlOz).toBe(3968);
    expect(p.shrinkageFlOz).toBe(3968 - 3305);
    expect(p.maxToUnits).toBe(6);
    expect(p.createsVolume).toBe(false);
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
  it("reports no ratio rather than NaN when nothing is being cracked", () => {
    const p = previewTransform({ fromUnits: 0, fromVolumeFlOz: HALF, toUnits: 0, toVolumeFlOz: SIXTH });
    expect(p.shrinkageRatio).toBe(0);
    expect(Number.isNaN(p.shrinkageRatio)).toBe(false);
  });

  it("reports no cap rather than Infinity when the target has no volume", () => {
    const p = previewTransform({ fromUnits: 1, fromVolumeFlOz: HALF, toUnits: 1, toVolumeFlOz: 0 });
    expect(p.maxToUnits).toBe(0);
    expect(Number.isFinite(p.maxToUnits)).toBe(true);
  });
});

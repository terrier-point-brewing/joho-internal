// lib/production/recipeLineage.test.ts
//
// Pure bill arithmetic for a derived recipe. The two functions answer different
// questions off the same pair of bills:
//   • conversionDelta      → what stock a conversion must reserve (a quantity)
//   • splitBillAgainstBase → how the bill reads on screen (a partition)
// The load-bearing rules are the zero floor on a reduced ingredient and the
// use of per-bbl rates rather than per-turn quantities, so the cases below are
// built from the real Carolina Brown Ale → Reaper's Harvest bill plus the
// boundaries either function could get wrong.
import { describe, it, expect } from "vitest";
import { conversionDelta, splitBillAgainstBase } from "./recipeLineage";

// Carolina Brown Ale at 20 bbl expected yield: 725 lb silo malt, 1.63 oz CTZ.
const BROWN_ALE = [
  { ingredient_id: "silo", quantity_per_bbl: 725 / 20 },
  { ingredient_id: "ctz", quantity_per_bbl: 1.63 / 20 },
];
// Reaper's Harvest — the same bill plus 68 lb of pumpkin puree.
const REAPERS = [
  { ingredient_id: "silo", quantity_per_bbl: 725 / 20 },
  { ingredient_id: "ctz", quantity_per_bbl: 1.63 / 20 },
  { ingredient_id: "puree", quantity_per_bbl: 68 / 20 },
];

describe("conversionDelta", () => {
  it("charges only the ingredient the derived recipe adds", () => {
    expect(conversionDelta(REAPERS, BROWN_ALE)).toEqual([
      { ingredient_id: "puree", quantity_per_bbl: 68 / 20 },
    ]);
  });

  it("charges the increase when a shared ingredient is dosed higher", () => {
    const dryHopped = [
      { ingredient_id: "silo", quantity_per_bbl: 725 / 20 },
      { ingredient_id: "ctz", quantity_per_bbl: 5 / 20 },
    ];
    const delta = conversionDelta(dryHopped, BROWN_ALE);
    expect(delta).toHaveLength(1);
    expect(delta[0].ingredient_id).toBe("ctz");
    expect(delta[0].quantity_per_bbl).toBeCloseTo((5 - 1.63) / 20, 12);
  });

  it("charges nothing for an ingredient the derived recipe uses less of", () => {
    // The base's malt is already in the liquid; a conversion cannot take it back.
    const lighter = [{ ingredient_id: "silo", quantity_per_bbl: 400 / 20 }];
    expect(conversionDelta(lighter, BROWN_ALE)).toEqual([]);
  });

  it("charges nothing for an ingredient the derived recipe drops entirely", () => {
    const dropped = [{ ingredient_id: "ctz", quantity_per_bbl: 1.63 / 20 }];
    expect(conversionDelta(dropped, BROWN_ALE)).toEqual([]);
  });

  it("returns nothing when the bills are identical — a clone with no delta", () => {
    // Coffee Epic today: a byte-identical copy of Epic Hazy IPA, coffee never added.
    expect(conversionDelta(BROWN_ALE, BROWN_ALE)).toEqual([]);
  });

  it("charges the whole bill when the base has no lines", () => {
    expect(conversionDelta(REAPERS, [])).toHaveLength(3);
  });

  it("returns nothing when the derived recipe has no lines", () => {
    // Orange Pilsner as it stands — an empty bill commits nothing either way.
    expect(conversionDelta([], BROWN_ALE)).toEqual([]);
  });

  it("compares rates, so a differing expected yield does not fake a delta", () => {
    // Same 725 lb per turn on both sides, but one recipe yields 18 bbl and the
    // other 20. Per-turn subtraction would read zero; the rate difference is real.
    const at18 = [{ ingredient_id: "silo", quantity_per_bbl: 725 / 18 }];
    const at20 = [{ ingredient_id: "silo", quantity_per_bbl: 725 / 20 }];
    const delta = conversionDelta(at18, at20);
    expect(delta[0].quantity_per_bbl).toBeCloseTo(725 / 18 - 725 / 20, 12);
  });

  it("sums duplicate lines on either side before comparing", () => {
    const twice = [
      { ingredient_id: "silo", quantity_per_bbl: 20 },
      { ingredient_id: "silo", quantity_per_bbl: 20 },
    ];
    const once = [{ ingredient_id: "silo", quantity_per_bbl: 25 }];
    expect(conversionDelta(twice, once)).toEqual([{ ingredient_id: "silo", quantity_per_bbl: 15 }]);
  });

  it("ignores a non-numeric quantity rather than producing NaN", () => {
    const bad = [{ ingredient_id: "puree", quantity_per_bbl: Number.NaN }];
    expect(conversionDelta(bad, [])).toEqual([]);
  });
});

describe("splitBillAgainstBase", () => {
  it("puts the base's ingredients in inherited and the addition in added", () => {
    const { inherited, added } = splitBillAgainstBase(REAPERS, BROWN_ALE);
    expect(inherited.map((l) => l.ingredient_id)).toEqual(["silo", "ctz"]);
    expect(added.map((l) => l.ingredient_id)).toEqual(["puree"]);
  });

  it("counts an increased shared ingredient as added, not inherited", () => {
    const dryHopped = [{ ingredient_id: "ctz", quantity_per_bbl: 5 / 20 }];
    const { inherited, added } = splitBillAgainstBase(dryHopped, BROWN_ALE);
    expect(inherited).toEqual([]);
    expect(added.map((l) => l.ingredient_id)).toEqual(["ctz"]);
  });

  it("counts a reduced shared ingredient as inherited — the conversion adds nothing", () => {
    const lighter = [{ ingredient_id: "silo", quantity_per_bbl: 400 / 20 }];
    const { inherited, added } = splitBillAgainstBase(lighter, BROWN_ALE);
    expect(inherited.map((l) => l.ingredient_id)).toEqual(["silo"]);
    expect(added).toEqual([]);
  });

  it("never places a line in both halves", () => {
    const { inherited, added } = splitBillAgainstBase(REAPERS, BROWN_ALE);
    expect(inherited.length + added.length).toBe(REAPERS.length);
  });

  it("treats every line as added when there is no base bill", () => {
    const { inherited, added } = splitBillAgainstBase(REAPERS, []);
    expect(inherited).toEqual([]);
    expect(added).toHaveLength(3);
  });

  it("preserves the caller's own row shape", () => {
    const rows = [{ id: "row-1", ingredient_id: "puree", quantity_per_bbl: 3.4 }];
    const { added } = splitBillAgainstBase(rows, BROWN_ALE);
    expect(added[0].id).toBe("row-1");
  });
});

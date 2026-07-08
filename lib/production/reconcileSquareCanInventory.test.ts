import { describe, it, expect } from "vitest";
import { planCanReconciliation, variantStem, pickBaseVariation, type ReconcileFamilyInput, type ItemVariation } from "./reconcileSquareCanInventory";

const fam = (over: Partial<ReconcileFamilyInput> = {}): ReconcileFamilyInput => ({
  recipeId: "r1",
  baseSquareVariationId: "SQ-LOOSE",
  baseVariationName: "16oz Labeled Can",
  cansEachByVar: { loose: 1, pack: 4, case: 24 },
  onHandByVar: { loose: 8, pack: 0, case: 1 }, // 8 + 24 = 32 loose-equiv
  ...over,
});

describe("planCanReconciliation", () => {
  it("writes cold-storage total onto the base variation when Square drifts", () => {
    const plan = planCanReconciliation({ families: [fam()], squareCountByVar: { "SQ-LOOSE": 61 } });
    expect(plan.writes).toEqual([
      { recipeId: "r1", baseSquareVariationId: "SQ-LOOSE", baseVariationName: "16oz Labeled Can", coldStorageCans: 32, squareCansBefore: 61, drift: 29 },
    ]);
  });

  it("no write when Square already matches within threshold", () => {
    const plan = planCanReconciliation({ families: [fam()], squareCountByVar: { "SQ-LOOSE": 32 } });
    expect(plan.writes).toEqual([]);
  });

  it("skips a family whose loose tier has no Square link", () => {
    const plan = planCanReconciliation({ families: [fam({ baseSquareVariationId: null })], squareCountByVar: {} });
    expect(plan.writes).toEqual([]);
    expect(plan.skips[0].reason).toMatch(/no base/i);
  });

  it("rounds a fractional loose-equivalent and warns", () => {
    const plan = planCanReconciliation({
      families: [fam({ onHandByVar: { loose: 0.6, pack: 0, case: 0 } })],
      squareCountByVar: { "SQ-LOOSE": 5 },
    });
    expect(plan.writes[0].coldStorageCans).toBe(1); // round(0.6)
    expect(plan.warnings.join()).toMatch(/fractional/i);
  });
});

const iv = (over: Partial<ItemVariation>): ItemVariation =>
  ({ squareVariationId: "sq", variationName: "Regular", volumeFlOzPerUnit: null, trackInventory: true, ...over });

describe("variantStem", () => {
  it("strips the size/format suffix", () => {
    expect(variantStem("Regular - 16oz Case")).toBe("Regular");
    expect(variantStem("Be Like Mike - 16oz 4-Pack")).toBe("Be Like Mike");
    expect(variantStem("Regular")).toBe("Regular");
  });
});

describe("pickBaseVariation", () => {
  it("returns the single tracked parent (volume null)", () => {
    const base = pickBaseVariation({
      itemVariations: [
        iv({ squareVariationId: "REG", variationName: "Regular" }),
        iv({ squareVariationId: "REG-CASE", variationName: "Regular - 16oz Case", volumeFlOzPerUnit: 384 }),
      ],
      stem: "Regular",
    });
    expect(base?.squareVariationId).toBe("REG");
  });

  it("disambiguates Regular vs Be Like Mike parents by stem", () => {
    const vars = [
      iv({ squareVariationId: "REG", variationName: "Regular" }),
      iv({ squareVariationId: "BLM", variationName: "Be Like Mike", trackInventory: false }),
    ];
    expect(pickBaseVariation({ itemVariations: vars, stem: "Regular" })?.squareVariationId).toBe("REG");
  });

  it("returns null when the matching parent is not inventory-tracked (Be Like Mike)", () => {
    const vars = [iv({ squareVariationId: "BLM", variationName: "Be Like Mike", trackInventory: false })];
    expect(pickBaseVariation({ itemVariations: vars, stem: "Be Like Mike" })).toBeNull();
  });

  it("returns null when ambiguous (multiple tracked parents, no stem match)", () => {
    const vars = [iv({ squareVariationId: "A", variationName: "Alpha" }), iv({ squareVariationId: "B", variationName: "Beta" })];
    expect(pickBaseVariation({ itemVariations: vars, stem: "Gamma" })).toBeNull();
  });
});

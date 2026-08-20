import { describe, it, expect } from "vitest";
import {
  normalizeUnit,
  ouncesPerUnit,
  conversionRatio,
  convertibleTargets,
  previewConversion,
  type IngredientUnit,
} from "./units";

/** The vocabulary as 20261016090000_ingredient_unit_vocabulary.sql seeds it. */
const VOCAB: IngredientUnit[] = [
  { code: "lbs",    label: "lbs",    dimension: "weight", base_factor: 16,     is_active: true, sort_order: 10 },
  { code: "oz",     label: "oz",     dimension: "weight", base_factor: 1,      is_active: true, sort_order: 20 },
  { code: "liters", label: "liters", dimension: "volume", base_factor: 33.814, is_active: true, sort_order: 30 },
  { code: "each",   label: "each",   dimension: "count",  base_factor: 1,      is_active: true, sort_order: 40 },
  { code: "bricks", label: "bricks", dimension: "count",  base_factor: null,   is_active: true, sort_order: 50 },
];

describe("normalizeUnit", () => {
  it("folds case, whitespace and a trailing period", () => {
    expect(normalizeUnit(" LBS ")).toBe("lbs");
    expect(normalizeUnit("Lbs.")).toBe("lbs");
  });
});

describe("ouncesPerUnit", () => {
  it("matches the vocabulary's weight factors exactly", () => {
    for (const u of VOCAB.filter((v) => v.dimension === "weight")) {
      expect(ouncesPerUnit(u.code)).toBe(u.base_factor);
    }
  });

  it("also matches typed-in aliases that are not offerable units", () => {
    expect(ouncesPerUnit("pound")).toBe(16);
    expect(ouncesPerUnit("#")).toBe(16);
    expect(ouncesPerUnit("kg")).toBeCloseTo(35.274, 3);
  });

  it("returns null for a unit with no assumed weight at all", () => {
    expect(ouncesPerUnit("")).toBeNull();
    expect(ouncesPerUnit("pallets")).toBeNull();
  });

  it("weighs a liter as water, for freight only", () => {
    expect(ouncesPerUnit("liters")).toBeCloseTo(35.274, 3);
    expect(ouncesPerUnit("l")).toBe(ouncesPerUnit("liters"));
  });

  it("keeps the liter's VOLUME factor separate from its assumed weight", () => {
    // 33.814 fl oz is what a liter is. 35.274 oz is what we assume it weighs.
    // Conflating them would let a density assumption rewrite a stock figure.
    const liters = VOCAB.find((u) => u.code === "liters")!;
    expect(liters.base_factor).toBeCloseTo(33.814, 3);
    expect(liters.dimension).toBe("volume");
    expect(conversionRatio("liters", "lbs", VOCAB)).toBeNull();
  });

  it("knows a dry yeast brick is 500 g, for freight only", () => {
    expect(ouncesPerUnit("bricks")).toBeCloseTo(500 / 28.3495, 2);
    expect(ouncesPerUnit("brick")).toBe(ouncesPerUnit("bricks"));
  });

  it("still refuses to CONVERT bricks — a freight weight is not a stock factor", () => {
    // The whole point of keeping base_factor null in the vocabulary: knowing
    // roughly what a brick weighs is enough to split a shipping bill and not
    // enough to restate someone's inventory.
    expect(conversionRatio("bricks", "lbs", VOCAB)).toBeNull();
    expect(conversionRatio("lbs", "bricks", VOCAB)).toBeNull();
    expect(convertibleTargets("bricks", VOCAB)).toEqual([]);
  });
});

describe("conversionRatio", () => {
  it("converts within a dimension", () => {
    expect(conversionRatio("lbs", "oz", VOCAB)).toBe(16);
    expect(conversionRatio("oz", "lbs", VOCAB)).toBe(1 / 16);
  });

  it("refuses across dimensions — pounds to liters needs a density nobody recorded", () => {
    expect(conversionRatio("lbs", "liters", VOCAB)).toBeNull();
    expect(conversionRatio("liters", "each", VOCAB)).toBeNull();
  });

  it("refuses a unit with no fixed factor rather than treating it as 1", () => {
    expect(conversionRatio("bricks", "each", VOCAB)).toBeNull();
    expect(conversionRatio("each", "bricks", VOCAB)).toBeNull();
  });

  it("refuses an unknown code", () => {
    expect(conversionRatio("lbs", "furlongs", VOCAB)).toBeNull();
  });
});

describe("convertibleTargets", () => {
  it("offers only the same-dimension units that have a ratio", () => {
    expect(convertibleTargets("lbs", VOCAB).map((u) => u.code)).toEqual(["oz"]);
  });

  it("offers nothing when the unit has no fixed factor", () => {
    expect(convertibleTargets("bricks", VOCAB)).toEqual([]);
  });

  it("offers nothing when the unit is alone in its dimension", () => {
    expect(convertibleTargets("liters", VOCAB)).toEqual([]);
  });

  it("skips retired units", () => {
    const withRetired: IngredientUnit[] = [
      ...VOCAB,
      { code: "sacks", label: "sacks", dimension: "weight", base_factor: 800, is_active: false, sort_order: 900 },
    ];
    expect(convertibleTargets("lbs", withRetired).map((u) => u.code)).toEqual(["oz"]);
  });
});

describe("previewConversion", () => {
  it("scales quantity up and unit cost down, leaving value untouched", () => {
    const before = { stock_quantity: 585.377, cost_per_unit_usd: 7.2 };
    const after = previewConversion(before, conversionRatio("lbs", "oz", VOCAB)!);

    expect(after.stock_quantity).toBeCloseTo(9366.032, 3);
    expect(after.cost_per_unit_usd).toBeCloseTo(0.45, 10);
    expect(after.stock_quantity * after.cost_per_unit_usd!).toBeCloseTo(
      before.stock_quantity * before.cost_per_unit_usd,
      6,
    );
  });

  it("leaves a null cost null", () => {
    const after = previewConversion({ stock_quantity: 10, cost_per_unit_usd: null }, 16);
    expect(after.cost_per_unit_usd).toBeNull();
    expect(after.stock_quantity).toBe(160);
  });

  it("round-trips back to the original", () => {
    const before = { stock_quantity: 585.377, cost_per_unit_usd: 7.2 };
    const there = previewConversion(before, conversionRatio("lbs", "oz", VOCAB)!);
    const back = previewConversion(there, conversionRatio("oz", "lbs", VOCAB)!);

    expect(back.stock_quantity).toBeCloseTo(before.stock_quantity, 9);
    expect(back.cost_per_unit_usd).toBeCloseTo(before.cost_per_unit_usd, 9);
  });
});

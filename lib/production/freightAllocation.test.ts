import { describe, it, expect } from "vitest";
import { allocateFreightByWeight } from "./freightAllocation";

describe("allocateFreightByWeight", () => {
  it("returns [] for no lines", () => {
    expect(allocateFreightByWeight([], 100)).toEqual({ dollars: [], guessed: [] });
  });

  it("splits proportional to quantity when all lines share the same known unit", () => {
    const { dollars: result } = allocateFreightByWeight(
      [{ unit: "lbs", quantity: 10 }, { unit: "lbs", quantity: 30 }],
      40
    );
    expect(result).toEqual([10, 30]);
  });

  it("splits by true weight (not raw quantity) across mixed known units", () => {
    const { dollars: result } = allocateFreightByWeight(
      [{ unit: "lb", quantity: 10 }, { unit: "oz", quantity: 16 }],
      17.6
    );
    expect(result).toEqual([16, 1.6]);
  });

  it("treats an unmatched unit as equivalent to the batch's majority matched unit", () => {
    const { dollars: result } = allocateFreightByWeight(
      [
        { unit: "lbs", quantity: 10 },
        { unit: "lbs", quantity: 10 },
        { unit: "pallets", quantity: 5 },
      ],
      40
    );
    expect(result).toEqual([16, 16, 8]);
  });

  it("falls back to raw-quantity proportioning when no line matches a known unit", () => {
    const { dollars: result } = allocateFreightByWeight(
      [{ unit: "pallets", quantity: 10 }, { unit: "cases", quantity: 30 }],
      40
    );
    expect(result).toEqual([10, 30]);
  });

  it("breaks a majority-unit tie deterministically by first occurrence", () => {
    // "oz" and "lb" both matched once each -> tie -> "oz" wins (appears first).
    // pallets (unmatched) is then treated as 1 pallet = 1 oz.
    const { dollars: result } = allocateFreightByWeight(
      [
        { unit: "oz", quantity: 5 },
        { unit: "lb", quantity: 2 },
        { unit: "pallets", quantity: 3 },
      ],
      40
    );
    expect(result).toEqual([5, 32, 3]);
  });

  it("distributes leftover cents to the lowest-index line on an exact tie", () => {
    const { dollars: result } = allocateFreightByWeight(
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

describe("allocateFreightByWeight — reporting the guess", () => {
  it("reports nothing when every line names a known weight", () => {
    const { guessed } = allocateFreightByWeight(
      [{ unit: "lbs", quantity: 10 }, { unit: "oz", quantity: 4 }],
      40
    );
    expect(guessed).toEqual([]);
  });

  it("names the line whose unit has no weight", () => {
    // A receipt unit nobody has weighed, alongside malt in lbs — it is counted
    // as though it weighed a pound, and until now nothing said so.
    const { guessed } = allocateFreightByWeight(
      [
        { unit: "lbs", quantity: 500, label: "Pilsner Malt" },
        { unit: "pallets", quantity: 2, label: "Mystery Adjunct" },
      ],
      100
    );
    expect(guessed).toEqual([{ label: "Mystery Adjunct", unit: "pallets" }]);
  });

  it("falls back to a positional label when none is given", () => {
    const { guessed } = allocateFreightByWeight(
      [{ unit: "lbs", quantity: 1 }, { unit: "pallets", quantity: 1 }],
      10
    );
    expect(guessed).toEqual([{ label: "line 2", unit: "pallets" }]);
  });

  it("reports every line when nothing is weighable — the pure count split", () => {
    // What packaging receipts do today: no unit column at all, so the whole
    // receipt is a count split. It should say so rather than look weighed.
    const { dollars, guessed } = allocateFreightByWeight(
      [{ unit: "", quantity: 1, label: "16oz Can" }, { unit: "", quantity: 3, label: "Label" }],
      40
    );
    expect(dollars).toEqual([10, 30]);
    expect(guessed).toEqual([
      { label: "16oz Can", unit: "" },
      { label: "Label", unit: "" },
    ]);
  });

  it("still reports the guess when the split collapses to zero", () => {
    const { dollars, guessed } = allocateFreightByWeight(
      [{ unit: "pallets", quantity: 0, label: "Mystery Adjunct" }],
      25
    );
    expect(dollars).toEqual([0]);
    expect(guessed).toEqual([{ label: "Mystery Adjunct", unit: "pallets" }]);
  });

  it("leaves the dollar split byte-identical to before", () => {
    // The reporting must not change a single cent of behaviour.
    const { dollars } = allocateFreightByWeight(
      [{ unit: "lb", quantity: 10 }, { unit: "oz", quantity: 16 }],
      17.6
    );
    expect(dollars).toEqual([16, 1.6]);
  });
});

describe("allocateFreightByWeight — yeast bricks now weigh something", () => {
  it("splits malt and yeast by real weight, and reports no guess", () => {
    // Before bricks had a nominal weight, 2 bricks were counted as 2 lbs
    // against 500 lbs of malt and took $0.60 of $150. At 500 g each they are
    // ~2.2 lbs, so the split barely moves — which is the point: the old number
    // was not wildly wrong, it was unfounded. Now it is founded.
    const { dollars, guessed } = allocateFreightByWeight(
      [
        { unit: "lbs", quantity: 500, label: "C10" },
        { unit: "bricks", quantity: 2, label: "Saf34/70" },
      ],
      150
    );
    expect(guessed).toEqual([]);
    expect(dollars[0] + dollars[1]).toBeCloseTo(150, 2);
    // 2 bricks = 35.274 oz against 8000 oz of malt.
    expect(dollars[1]).toBeCloseTo(150 * (35.274 / 8035.274), 1);
  });

  it("weighs liters as water, so no guess is reported", () => {
    const { guessed, dollars } = allocateFreightByWeight(
      [
        { unit: "lbs", quantity: 100, label: "Malt" },
        { unit: "liters", quantity: 5, label: "Liquid Yeast" },
      ],
      50
    );
    expect(guessed).toEqual([]);
    // 5 L = 176.37 oz against 1600 oz of malt.
    expect(dollars[1]).toBeCloseTo(50 * (176.37 / 1776.37), 1);
  });
});

describe("allocateFreightByWeight — packaging weighs by the piece", () => {
  it("splits a mixed packaging receipt by weight, not piece count", () => {
    // The defect this exists to fix: 4,000 cans (0.55 oz) and 5,000 labels
    // (0.02 oz) on one invoice. By count the labels take 5/9 of the freight;
    // by weight they take under 5%.
    const { dollars, guessed } = allocateFreightByWeight(
      [
        { unit: "", quantity: 4000, label: "16oz Blank", ouncesPerPiece: 0.55 },
        { unit: "", quantity: 5000, label: "CBC Oktoberfest Label", ouncesPerPiece: 0.02 },
      ],
      900
    );
    expect(guessed).toEqual([]);
    expect(dollars[0] + dollars[1]).toBeCloseTo(900, 2);
    expect(dollars[1]).toBeLessThan(45);
    // What the old count split would have charged the labels.
    expect(dollars[1]).toBeLessThan(900 * (5000 / 9000));
  });

  it("reports the item with no recorded weight and still splits the rest", () => {
    const { dollars, guessed } = allocateFreightByWeight(
      [
        { unit: "", quantity: 100, label: "16oz Blank", ouncesPerPiece: 0.55 },
        { unit: "", quantity: 100, label: "Mystery Carton", ouncesPerPiece: null },
      ],
      100
    );
    expect(guessed).toEqual([{ label: "Mystery Carton", unit: "" }]);
    expect(dollars[0] + dollars[1]).toBeCloseTo(100, 2);
  });

  it("takes precedence over the unit lookup", () => {
    // If a caller states the weight, that wins — the unit string is not
    // consulted at all.
    const { dollars } = allocateFreightByWeight(
      [
        { unit: "lbs", quantity: 1, ouncesPerPiece: 1 },
        { unit: "lbs", quantity: 1 },
      ],
      17
    );
    expect(dollars).toEqual([1, 16]);
  });

  it("a directly-weighed line never becomes the majority unit", () => {
    // Packaging passes unit:"" alongside a weight. If that empty string could
    // win the majority vote, an unweighed line would inherit a nonsense factor.
    const { dollars } = allocateFreightByWeight(
      [
        { unit: "", quantity: 1, label: "Weighed", ouncesPerPiece: 100 },
        { unit: "", quantity: 1, label: "Weighed too", ouncesPerPiece: 100 },
        { unit: "lbs", quantity: 1, label: "Malt" },
      ],
      216
    );
    // 100 + 100 + 16 oz total.
    expect(dollars).toEqual([100, 100, 16]);
  });
});

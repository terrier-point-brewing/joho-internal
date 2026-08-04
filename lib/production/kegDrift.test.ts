import { describe, it, expect } from "vitest";
import { measureKegDrift, type KegLink } from "./kegDrift";
import { coldStorageKey, type ColdStorageOnHand } from "./coldStorageOnHand";

function cs(entries: [string, string, number][]): Map<string, ColdStorageOnHand> {
  return new Map(
    entries.map(([recipeId, variationId, qty]) => [
      coldStorageKey(recipeId, variationId),
      { qty, totalVolumeFlOz: 1984, format: "loose", containerType: "keg" } satisfies ColdStorageOnHand,
    ]),
  );
}

function link(over: Partial<KegLink> = {}): KegLink {
  return {
    recipeId: "R1",
    variationId: "PV-HALF",
    squareVariationId: "SQ-HALF",
    variationName: "1/2 Keg",
    coldStorageLabel: "1/2 Keg",
    ...over,
  };
}

const SIXTH = link({ variationId: "PV-SIXTH", squareVariationId: "SQ-SIXTH", variationName: "1/6 Keg", coldStorageLabel: "1/6 Keg" });

describe("measureKegDrift", () => {
  it("reports zero drift when both sides agree", () => {
    const res = measureKegDrift({
      links: [link()],
      coldStorage: cs([["R1", "PV-HALF", 4]]),
      squareCountByVar: { "SQ-HALF": 4 },
    });
    expect(res.measurements).toEqual([
      expect.objectContaining({ coldStorageKegs: 4, squareKegs: 4, drift: 0 }),
    ]);
    expect(res.unmeasured).toEqual([]);
  });

  it("signs drift as Square minus cold storage", () => {
    const res = measureKegDrift({
      links: [link(), SIXTH],
      coldStorage: cs([["R1", "PV-HALF", 2], ["R1", "PV-SIXTH", 0]]),
      squareCountByVar: { "SQ-HALF": 0, "SQ-SIXTH": 10 },
    });
    expect(res.measurements.map((m) => m.drift)).toEqual([-2, 10]);
  });

  // The bug real data caught: Vienna Lager keeps a house "1/6 Keg" and a
  // contract-branded "Fortnight - 1/6 Keg", both mapped to ONE Square SKU.
  // Comparing each separately gave two rows against the same Square number and
  // both were wrong; the comparable quantity is their sum.
  it("sums every cold-storage variation mapped to one Square SKU", () => {
    const res = measureKegDrift({
      links: [
        link({ variationId: "PV-HOUSE", squareVariationId: "SQ-SIXTH", variationName: "1/6 Keg", coldStorageLabel: "1/6 Keg" }),
        link({ variationId: "PV-FORTNIGHT", squareVariationId: "SQ-SIXTH", variationName: "1/6 Keg", coldStorageLabel: "Fortnight - 1/6 Keg" }),
      ],
      coldStorage: cs([["R1", "PV-HOUSE", 31], ["R1", "PV-FORTNIGHT", 0]]),
      squareCountByVar: { "SQ-SIXTH": 7 },
    });

    expect(res.measurements).toHaveLength(1);
    expect(res.measurements[0]).toMatchObject({ coldStorageKegs: 31, squareKegs: 7, drift: -24 });
  });

  it("shows the components that sum to the compared total", () => {
    const res = measureKegDrift({
      links: [
        link({ variationId: "PV-HOUSE", squareVariationId: "SQ-SIXTH", coldStorageLabel: "1/6 Keg" }),
        link({ variationId: "PV-FORTNIGHT", squareVariationId: "SQ-SIXTH", coldStorageLabel: "Fortnight - 1/6 Keg" }),
      ],
      coldStorage: cs([["R1", "PV-HOUSE", 6], ["R1", "PV-FORTNIGHT", 4]]),
      squareCountByVar: { "SQ-SIXTH": 10 },
    });
    const m = res.measurements[0];
    expect(m.components).toEqual([
      { variationId: "PV-HOUSE", label: "1/6 Keg", onHand: 6 },
      { variationId: "PV-FORTNIGHT", label: "Fortnight - 1/6 Keg", onHand: 4 },
    ]);
    expect(m.components.reduce((s, c) => s + c.onHand, 0)).toBe(m.coldStorageKegs);
  });

  it("counts a cold-storage variation once even if it is mapped twice", () => {
    const dupe = link({ variationId: "PV-HALF", squareVariationId: "SQ-HALF" });
    const res = measureKegDrift({
      links: [dupe, { ...dupe }],
      coldStorage: cs([["R1", "PV-HALF", 5]]),
      squareCountByVar: { "SQ-HALF": 5 },
    });
    expect(res.measurements[0].coldStorageKegs).toBe(5);
    expect(res.measurements[0].components).toHaveLength(1);
  });

  it("flags one Square SKU claimed by more than one recipe", () => {
    const res = measureKegDrift({
      links: [
        link({ recipeId: "R1", variationId: "PV-A", squareVariationId: "SQ-HALF" }),
        link({ recipeId: "R2", variationId: "PV-B", squareVariationId: "SQ-HALF" }),
      ],
      coldStorage: cs([["R1", "PV-A", 1], ["R2", "PV-B", 2]]),
      squareCountByVar: { "SQ-HALF": 3 },
    });
    expect(res.measurements[0].multiRecipe).toEqual(["R1", "R2"]);
    expect(res.measurements[0].drift).toBe(0);
  });

  it("leaves multiRecipe unset for the ordinary single-recipe case", () => {
    const res = measureKegDrift({
      links: [link()],
      coldStorage: cs([["R1", "PV-HALF", 1]]),
      squareCountByVar: { "SQ-HALF": 1 },
    });
    expect(res.measurements[0].multiRecipe).toBeUndefined();
  });

  // The distinction the can reconciler got wrong for nine days.
  it("treats a variation Square gave no count for as unmeasurable, not as zero", () => {
    const res = measureKegDrift({
      links: [link()],
      coldStorage: cs([["R1", "PV-HALF", 3]]),
      squareCountByVar: {},
    });
    expect(res.measurements).toEqual([]);
    expect(res.unmeasured).toEqual([
      expect.objectContaining({ squareVariationId: "SQ-HALF", reason: expect.stringMatching(/unknown, not zero/) }),
    ]);
  });

  // The asymmetry is deliberate: the app owns cold storage, so a missing row
  // there really is a statement that none are on hand.
  it("treats a missing cold-storage row as zero on hand", () => {
    const res = measureKegDrift({
      links: [link()],
      coldStorage: new Map(),
      squareCountByVar: { "SQ-HALF": 5 },
    });
    expect(res.measurements).toEqual([
      expect.objectContaining({ coldStorageKegs: 0, squareKegs: 5, drift: 5 }),
    ]);
  });

  it("keeps each keg size separate rather than pooling them", () => {
    const res = measureKegDrift({
      links: [link(), SIXTH],
      coldStorage: cs([["R1", "PV-HALF", 1], ["R1", "PV-SIXTH", 1]]),
      squareCountByVar: { "SQ-HALF": 1, "SQ-SIXTH": 1 },
    });
    expect(res.measurements).toHaveLength(2);
    expect(new Set(res.measurements.map((m) => m.squareVariationId))).toEqual(new Set(["SQ-HALF", "SQ-SIXTH"]));
  });

  it("returns nothing at all when there are no keg links", () => {
    expect(measureKegDrift({ links: [], coldStorage: new Map(), squareCountByVar: {} }))
      .toEqual({ measurements: [], unmeasured: [] });
  });
});

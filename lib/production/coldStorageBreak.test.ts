import { describe, it, expect } from "vitest";
import { planBreakDown, type Tier } from "./coldStorageBreak";

// 16oz family: single=1 can, 4-pack=4, case=24.
const fam = (single: number, pack: number, kase: number): Tier[] => [
  { variationId: "single", format: "loose", cansEach: 1, onHand: single },
  { variationId: "pack", format: "4-pack", cansEach: 4, onHand: pack },
  { variationId: "case", format: "case", cansEach: 24, onHand: kase },
];

describe("planBreakDown", () => {
  it("no-ops when the target tier already covers the need", () => {
    const p = planBreakDown({ tiers: fam(5, 0, 0), targetVariationId: "single", needed: 3 });
    expect(p.ops).toEqual([]);
    expect(p.shortfall).toBe(0);
    expect(p.resultingOnHand.single).toBe(5);
  });

  it("cracks one 4-pack to cover a single sale, leaving the remainder loose", () => {
    const p = planBreakDown({ tiers: fam(0, 1, 0), targetVariationId: "single", needed: 3 });
    expect(p.ops).toEqual([{ fromVariationId: "pack", toVariationId: "single", fromUnits: 1, toUnits: 4 }]);
    expect(p.resultingOnHand.single).toBe(4); // 1 leftover after the eventual 3-can sale
    expect(p.shortfall).toBe(0);
  });

  it("prefers cracking a loose pack over a sealed case (protects wholesale cases)", () => {
    const p = planBreakDown({ tiers: fam(0, 1, 2), targetVariationId: "single", needed: 2 });
    expect(p.ops).toEqual([{ fromVariationId: "pack", toVariationId: "single", fromUnits: 1, toUnits: 4 }]);
    expect(p.resultingOnHand.case).toBe(2); // cases untouched
  });

  it("cascades case->pack->single when no loose packs exist (case never breaks straight to singles)", () => {
    const p = planBreakDown({ tiers: fam(0, 0, 1), targetVariationId: "single", needed: 3 });
    expect(p.ops).toEqual([
      { fromVariationId: "case", toVariationId: "pack", fromUnits: 1, toUnits: 6 },
      { fromVariationId: "pack", toVariationId: "single", fromUnits: 1, toUnits: 4 },
    ]);
    expect(p.resultingOnHand.case).toBe(0);
    expect(p.resultingOnHand.pack).toBe(5); // 6 produced - 1 cracked
    expect(p.resultingOnHand.single).toBe(4);
    expect(p.shortfall).toBe(0);
  });

  it("breaks a case into packs to fulfill a 4-pack sale", () => {
    const p = planBreakDown({ tiers: fam(0, 0, 1), targetVariationId: "pack", needed: 2 });
    expect(p.ops).toEqual([{ fromVariationId: "case", toVariationId: "pack", fromUnits: 1, toUnits: 6 }]);
    expect(p.resultingOnHand.pack).toBe(6);
  });

  it("reports a shortfall when even all higher tiers can't cover the need", () => {
    const p = planBreakDown({ tiers: fam(0, 1, 0), targetVariationId: "single", needed: 10 });
    // 1 pack -> 4 singles, still short 6.
    expect(p.ops).toEqual([{ fromVariationId: "pack", toVariationId: "single", fromUnits: 1, toUnits: 4 }]);
    expect(p.shortfall).toBe(6);
  });

  it("handles a 6-pack family (case=24 -> 4 six-packs, six-pack -> 6 singles)", () => {
    const sixFam: Tier[] = [
      { variationId: "s", format: "loose", cansEach: 1, onHand: 0 },
      { variationId: "p", format: "6-pack", cansEach: 6, onHand: 0 },
      { variationId: "c", format: "case", cansEach: 24, onHand: 1 },
    ];
    const p = planBreakDown({ tiers: sixFam, targetVariationId: "s", needed: 5 });
    expect(p.ops).toEqual([
      { fromVariationId: "c", toVariationId: "p", fromUnits: 1, toUnits: 4 },
      { fromVariationId: "p", toVariationId: "s", fromUnits: 1, toUnits: 6 },
    ]);
    expect(p.resultingOnHand.s).toBe(6);
    expect(p.shortfall).toBe(0);
  });

  it("throws when the target variation is not among the tiers", () => {
    expect(() => planBreakDown({ tiers: fam(0, 0, 0), targetVariationId: "ghost", needed: 1 }))
      .toThrow(/not in tiers/);
  });
});

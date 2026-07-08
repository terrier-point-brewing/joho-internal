import { describe, it, expect } from "vitest";
import { planBreakDown, type Tier, deriveCansEach } from "./coldStorageBreak";

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

describe("deriveCansEach", () => {
  const v = (variationId: string, format: string, totalVolumeFlOz: number) => ({ variationId, format, totalVolumeFlOz });

  it("derives cans-per-tier from volume relative to the loose can", () => {
    const { tiers, warnings } = deriveCansEach({ variations: [
      v("single", "loose", 16), v("pack", "4-pack", 64), v("case", "case", 384),
    ] });
    expect(tiers).toEqual([
      { variationId: "single", format: "loose", cansEach: 1 },
      { variationId: "pack", format: "4-pack", cansEach: 4 },
      { variationId: "case", format: "case", cansEach: 24 },
    ]);
    expect(warnings).toEqual([]);
  });

  it("derives a 6-pack family correctly when volume agrees with format", () => {
    const { tiers, warnings } = deriveCansEach({ variations: [
      v("s", "loose", 12), v("p", "6-pack", 72), v("c", "case", 288),
    ] });
    expect(tiers.find((t) => t.variationId === "p")!.cansEach).toBe(6);
    expect(warnings).toEqual([]);
  });

  it("warns when a pack's volume disagrees with the count implied by its format", () => {
    // 12oz '6-pack' whose volume is 48 (=4 cans), not 72 — the known data bug.
    const { tiers, warnings } = deriveCansEach({ variations: [
      v("s", "loose", 12), v("p", "6-pack", 48),
    ] });
    expect(tiers.find((t) => t.variationId === "p")!.cansEach).toBe(4); // volume is authoritative
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/6-pack/);
    expect(warnings[0]).toMatch(/expected 6/);
  });

  it("throws when there is no loose base-can variation to normalize against", () => {
    expect(() => deriveCansEach({ variations: [v("p", "4-pack", 64)] }))
      .toThrow(/no loose/i);
  });

  it("warns when a derived can count is not a whole number", () => {
    const { warnings } = deriveCansEach({ variations: [
      v("s", "loose", 16), v("pack", "4-pack", 70), // 70/16 = 4.375
    ] });
    expect(warnings.some((w) => /whole number/i.test(w))).toBe(true);
  });
});

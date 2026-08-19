import { describe, it, expect } from "vitest";
import { computeIbu, canCalculateIbu, type IbuLine, type IbuInputs } from "./recipeIbu";

function hop(over: Partial<IbuLine> = {}): IbuLine {
  return {
    name: "Citra",
    category: "Hops",
    quantityPerTurn: 10,
    unit: "lbs",
    alphaAcid: 12,
    boilMinutes: 60,
    ...over,
  };
}

/** 19.5 bbl = 604.5 gal, OG 1.052 — Black Lager's real shape. */
function inputs(over: Partial<IbuInputs> = {}): IbuInputs {
  return { lines: [hop()], expectedYieldBbl: 19.5, originalGravity: 1.052, ...over };
}

describe("computeIbu", () => {
  it("matches Tinseth worked by hand", () => {
    // bigness = 1.65 * 0.000125^0.052     = 1.03400...
    // btf     = (1 - e^(-0.04*60)) / 4.15  = 0.21910...
    // oz      = 10 lbs * 16                = 160
    // gallons = 19.5 bbl * 31              = 604.5
    // IBU     = 1.03400 * 0.21910 * 0.12 * 160 * 7490 / 604.5
    const { value } = computeIbu(inputs());
    expect(value).toBeCloseTo(53.9, 1);
  });

  it("sums multiple additions", () => {
    const one = computeIbu(inputs()).value!;
    const two = computeIbu(inputs({ lines: [hop(), hop()] })).value!;
    expect(two).toBeCloseTo(one * 2, 6);
  });

  it("weights a late addition far below a bittering one", () => {
    const sixty = computeIbu(inputs()).value!;
    const whirlpool = computeIbu(inputs({ lines: [hop({ boilMinutes: 5 })] })).value!;
    // This ratio is exactly why boil time cannot be defaulted.
    expect(sixty / whirlpool).toBeGreaterThan(5);
  });

  it("falls as wort gets thicker", () => {
    const session = computeIbu(inputs({ originalGravity: 1.04 })).value!;
    const imperial = computeIbu(inputs({ originalGravity: 1.09 })).value!;
    expect(imperial).toBeLessThan(session);
  });

  it("converts the hop weight through the unit vocabulary", () => {
    const inLbs = computeIbu(inputs({ lines: [hop({ quantityPerTurn: 1, unit: "lbs" })] })).value!;
    const inOz = computeIbu(inputs({ lines: [hop({ quantityPerTurn: 16, unit: "oz" })] })).value!;
    expect(inOz).toBeCloseTo(inLbs, 9);
  });

  it("ignores non-hop lines", () => {
    const withMalt = computeIbu(
      inputs({ lines: [hop(), { ...hop(), name: "Munich", category: "Malts", alphaAcid: null, boilMinutes: null }] }),
    );
    expect(withMalt.value).toBeCloseTo(computeIbu(inputs()).value!, 9);
  });
});

describe("computeIbu — refuses a partial answer", () => {
  it("returns null and names a hop missing its alpha acid", () => {
    const r = computeIbu(inputs({ lines: [hop(), hop({ name: "Saaz", alphaAcid: null })] }));
    expect(r.value).toBeNull();
    expect(r.missing).toContain("alpha acid for Saaz");
  });

  it("returns null and names a hop missing its boil time", () => {
    const r = computeIbu(inputs({ lines: [hop({ name: "CTZ", boilMinutes: null })] }));
    expect(r.value).toBeNull();
    expect(r.missing).toContain("boil time for CTZ");
  });

  it("does not silently drop the untimed hop and total the rest", () => {
    // The failure this guards: 2 of 3 additions summing to a plausible-looking
    // number that is simply too low, with nothing on screen to say so.
    const r = computeIbu(inputs({ lines: [hop(), hop(), hop({ name: "Late", boilMinutes: null })] }));
    expect(r.value).toBeNull();
  });

  it("requires original gravity", () => {
    const r = computeIbu(inputs({ originalGravity: null }));
    expect(r.value).toBeNull();
    expect(r.missing).toContain("original gravity");
  });

  it("requires an expected yield", () => {
    for (const y of [null, 0]) {
      const r = computeIbu(inputs({ expectedYieldBbl: y }));
      expect(r.value).toBeNull();
      expect(r.missing).toContain("expected yield");
    }
  });

  it("reports a hop measured in something with no weight", () => {
    const r = computeIbu(inputs({ lines: [hop({ name: "Cryo", unit: "bricks" })] }));
    expect(r.value).toBeNull();
    expect(r.missing.join(" ")).toContain("Cryo");
  });

  it("says so when there are no hops at all", () => {
    const r = computeIbu(inputs({ lines: [{ ...hop(), category: "Malts" }] }));
    expect(r.value).toBeNull();
    expect(r.missing).toContain("no hops in the bill");
  });

  it("collects every missing input, not just the first", () => {
    const r = computeIbu({
      lines: [hop({ name: "A", alphaAcid: null }), hop({ name: "B", boilMinutes: null })],
      expectedYieldBbl: null,
      originalGravity: null,
    });
    expect(r.missing).toEqual(
      expect.arrayContaining(["expected yield", "original gravity", "alpha acid for A", "boil time for B"]),
    );
  });
});

describe("canCalculateIbu", () => {
  it("is false for today's data — no hop has an alpha acid", () => {
    expect(canCalculateIbu(inputs({ lines: [hop({ alphaAcid: null, boilMinutes: null })] }))).toBe(false);
  });

  it("is true once the bill is complete", () => {
    expect(canCalculateIbu(inputs())).toBe(true);
  });
});

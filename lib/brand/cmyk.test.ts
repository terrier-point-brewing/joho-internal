import { describe, expect, it } from "vitest";
import { cmykFromHex } from "./cmyk";

describe("cmykFromHex", () => {
  // The load-bearing test: these four values were hand-entered in the canon
  // before this module existed. If the formula ever stops reproducing them, the
  // derived values for every other color have silently changed provenance.
  it.each([
    ["indigo", "#26355d", "59 43 0 64"],
    ["paper", "#f5f0e6", "0 2 6 4"],
    ["seal-red", "#ad1a2d", "0 85 74 32"],
    ["camphor", "#b3a585", "0 8 26 30"],
  ])("reproduces the authored value for %s", (_name, hex, expected) => {
    expect(cmykFromHex(hex)).toBe(expected);
  });

  it("puts the whole ink load on K for pure black", () => {
    expect(cmykFromHex("#000000")).toBe("0 0 0 100");
  });

  it("returns all zeros for pure white", () => {
    expect(cmykFromHex("#ffffff")).toBe("0 0 0 0");
  });

  it("accepts uppercase and a missing leading #", () => {
    expect(cmykFromHex("26355D")).toBe("59 43 0 64");
    expect(cmykFromHex("#26355D")).toBe("59 43 0 64");
  });

  it("ignores surrounding whitespace", () => {
    expect(cmykFromHex("  #26355d  ")).toBe("59 43 0 64");
  });

  it("returns null for anything that is not a 6-digit hex", () => {
    for (const bad of ["", "#fff", "#26355", "#26355dd", "rgb(0,0,0)", "#gggggg"]) {
      expect(cmykFromHex(bad)).toBeNull();
    }
  });

  it("never emits a percentage outside 0–100", () => {
    for (const hex of ["#000000", "#ffffff", "#f37149", "#131b2f", "#afb7ca"]) {
      const parts = cmykFromHex(hex)!.split(" ").map(Number);
      expect(parts).toHaveLength(4);
      for (const p of parts) {
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(100);
      }
    }
  });
});

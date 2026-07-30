import { describe, expect, it } from "vitest";
import { SNAP_THRESHOLD, deltaE, hexToOklab, nearestKey } from "./colorDistance";

describe("hexToOklab", () => {
  it("maps black and white to the ends of the lightness axis", () => {
    expect(hexToOklab("#000000")[0]).toBeCloseTo(0, 5);
    expect(hexToOklab("#ffffff")[0]).toBeCloseTo(1, 2);
  });
});

describe("deltaE", () => {
  it("reports zero for identical colors", () => {
    expect(deltaE("#26355d", "#26355d")).toBe(0);
  });

  it("is symmetric", () => {
    expect(deltaE("#26355d", "#f5f0e6")).toBeCloseTo(deltaE("#f5f0e6", "#26355d"), 10);
  });

  it("separates Seal Red from the brighter dark-mode Vermilion", () => {
    expect(deltaE("#ad1a2d", "#f37149")).toBeGreaterThan(SNAP_THRESHOLD);
  });

  it("keeps a near-identical pair under the snap threshold", () => {
    expect(deltaE("#26355d", "#26355e")).toBeLessThan(SNAP_THRESHOLD);
  });

  it("does not call a warm tan close to a cool blue-grey", () => {
    // The reason this module uses OKLab rather than RGB euclidean: Camphor Tan
    // and a cool dark-mode muted text color are far apart perceptually, and
    // snapping one to the other would visibly warm every muted line.
    expect(deltaE("#b3a585", "#939ebe")).toBeGreaterThan(SNAP_THRESHOLD);
  });
});

describe("nearestKey", () => {
  const palette = [
    { key: "indigo", hex: "#26355d" },
    { key: "paper", hex: "#f5f0e6" },
    { key: "seal-red", hex: "#ad1a2d" },
  ];

  it("finds the closest palette entry", () => {
    expect(nearestKey("#26355e", palette)?.key).toBe("indigo");
    expect(nearestKey("#f4efe5", palette)?.key).toBe("paper");
  });

  it("reports the distance alongside the key", () => {
    const match = nearestKey("#26355d", palette);
    expect(match?.distance).toBe(0);
  });

  it("returns null for an empty palette", () => {
    expect(nearestKey("#26355d", [])).toBeNull();
  });
});

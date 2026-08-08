import { describe, expect, it } from "vitest";
import { luminanceForImageData } from "./rasterLuminance";
import { groundForLuminance } from "./svgColor";

/** Builds RGBA pixel data from [r,g,b,a] tuples. */
function pixels(...px: [number, number, number, number][]): Uint8ClampedArray {
  return new Uint8ClampedArray(px.flat());
}

const OPAQUE = 255;

describe("luminanceForImageData", () => {
  it("returns null when every pixel is transparent", () => {
    expect(luminanceForImageData(pixels([255, 255, 255, 0], [0, 0, 0, 0]))).toBeNull();
  });

  it("ignores transparent pixels rather than averaging them in", () => {
    // A white mark on a mostly-empty canvas is white, not mid-grey.
    const stats = luminanceForImageData(
      pixels([255, 255, 255, OPAQUE], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]),
    );
    expect(stats!.mean).toBeCloseTo(1, 5);
    expect(groundForLuminance(stats)).toBe("dark");
  });

  it("weights anti-aliased edge pixels by their alpha", () => {
    // One solid white pixel plus a barely-there edge pixel of the same colour.
    // Counting the edge whole would still read white here; what matters is that
    // a faint DARK fringe can't drag a white mark toward the middle.
    const stats = luminanceForImageData(
      pixels([255, 255, 255, OPAQUE], [0, 0, 0, 20]),
    );
    expect(stats!.mean).toBeGreaterThan(0.9);
    expect(groundForLuminance(stats)).toBe("dark");
  });

  it("puts dark artwork on a light ground", () => {
    const stats = luminanceForImageData(pixels([17, 17, 17, OPAQUE], [0, 0, 0, 0]));
    expect(groundForLuminance(stats)).toBe("light");
  });

  it("leaves artwork that carries its own contrast on the neutral surface", () => {
    const stats = luminanceForImageData(
      pixels([255, 255, 255, OPAQUE], [0, 0, 0, OPAQUE]),
    );
    expect(stats!.spread).toBeGreaterThan(0.5);
    expect(groundForLuminance(stats)).toBe("neutral");
  });

  it("takes the spread from solid ink, not from the blended fringe", () => {
    // A flat white mark whose edge pixels sample as dark-but-faint. Letting the
    // fringe set the range would call this multi-colour and skip the ground.
    const stats = luminanceForImageData(
      pixels([255, 255, 255, OPAQUE], [255, 255, 255, OPAQUE], [10, 10, 10, 30]),
    );
    expect(stats!.spread).toBe(0);
    expect(groundForLuminance(stats)).toBe("dark");
  });

  it("leaves mid-luminance ink neutral instead of guessing", () => {
    const stats = luminanceForImageData(pixels([128, 128, 128, OPAQUE]));
    expect(groundForLuminance(stats)).toBe("neutral");
  });
});

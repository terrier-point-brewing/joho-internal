import { describe, expect, it } from "vitest";
import { clampPos, sliderTicks } from "./blockHelpers";

describe("clampPos", () => {
  it("passes an in-range position through unchanged", () => {
    expect(clampPos(40)).toBe(40);
    expect(clampPos(0)).toBe(0);
    expect(clampPos(100)).toBe(100);
  });

  it("clamps a position above the track", () => {
    // A canon value out of range must not push the dot outside the track.
    expect(clampPos(150)).toBe(100);
  });

  it("clamps a position below the track", () => {
    expect(clampPos(-20)).toBe(0);
  });

  it("falls back to the midpoint for a non-finite value", () => {
    expect(clampPos(Number.NaN)).toBe(50);
    expect(clampPos(Number.POSITIVE_INFINITY)).toBe(100);
  });

  it("rounds to a whole number for the readout", () => {
    expect(clampPos(40.6)).toBe(41);
  });
});

describe("sliderTicks", () => {
  it("marks the quarter points", () => {
    expect(sliderTicks()).toEqual([0, 25, 50, 75, 100]);
  });
});

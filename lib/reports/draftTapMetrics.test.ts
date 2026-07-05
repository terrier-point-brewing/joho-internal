import { describe, it, expect } from "vitest";
import { swapReserveFlOz, tapBblOnHand } from "./draftTapMetrics";
import { BBL_TO_FL_OZ } from "@/lib/constants/production";

describe("swapReserveFlOz", () => {
  it("multiplies swap kegs on hand by the full-keg volume", () => {
    expect(swapReserveFlOz(13, 660)).toBe(13 * 660);
  });
  it("is zero when no swap volume is configured", () => {
    expect(swapReserveFlOz(13, null)).toBe(0);
    expect(swapReserveFlOz(13, 0)).toBe(0);
  });
  it("is zero when nothing is on hand", () => {
    expect(swapReserveFlOz(0, 660)).toBe(0);
    expect(swapReserveFlOz(-2, 660)).toBe(0);
  });
});

describe("tapBblOnHand", () => {
  it("sums beer on tap and swap reserve, in BBL", () => {
    expect(tapBblOnHand(660, 13 * 660)).toBeCloseTo((660 + 13 * 660) / BBL_TO_FL_OZ, 6);
  });
  it("nets a negative on-tap level against the reserve", () => {
    expect(tapBblOnHand(-120, 660)).toBeCloseTo((-120 + 660) / BBL_TO_FL_OZ, 6);
  });
  it("is just the draft when there is no reserve", () => {
    expect(tapBblOnHand(330, 0)).toBeCloseTo(330 / BBL_TO_FL_OZ, 6);
  });
});

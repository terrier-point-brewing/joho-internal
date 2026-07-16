import { describe, it, expect } from "vitest";
import { defaultYearRange } from "./dateRange";

describe("defaultYearRange", () => {
  it("returns Jan 1 - Dec 31 for the given year", () => {
    expect(defaultYearRange(2026)).toEqual({ from: "2026-01-01", to: "2026-12-31" });
  });
  it("defaults to the current year when no arg is given", () => {
    const currentYear = new Date().getFullYear();
    const { from, to } = defaultYearRange();
    expect(from.startsWith(String(currentYear))).toBe(true);
    expect(to.startsWith(String(currentYear))).toBe(true);
  });
});

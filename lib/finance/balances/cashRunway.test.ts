import { describe, it, expect } from "vitest";
import { burnRateCents, runwayMonths } from "./cashRunway";

const OPS = {
  "2026-04": -3_917,      // a small April burn
  "2026-05": 1_175_725,
  "2026-06": 884_449,
  "2026-07": 1_600_250,
  "2026-08": 277_860,     // the open month — three weeks of a month
};

describe("burnRateCents", () => {
  it("averages the last three ENDED months and ignores the open one", () => {
    const burn = burnRateCents(OPS, "2026-08");
    expect(burn).toBe(Math.round((1_175_725 + 884_449 + 1_600_250) / 3));
  });

  it("ignores all-zero months so a young company's burn is not averaged toward nothing", () => {
    const burn = burnRateCents({ "2026-01": 0, "2026-02": 0, "2026-03": -300_000 }, "2026-04");
    expect(burn).toBe(-300_000);
  });

  it("returns null with nothing to average", () => {
    expect(burnRateCents({}, "2026-08")).toBeNull();
    expect(burnRateCents({ "2026-08": -100 }, "2026-08")).toBeNull();
  });
});

describe("runwayMonths", () => {
  it("divides cash by a burn, to one decimal", () => {
    expect(runwayMonths(9_000_000, -1_000_000)).toBe(9);
    expect(runwayMonths(9_500_000, -1_000_000)).toBe(9.5);
  });

  it("no burn, no countdown — positive or zero operating cash yields null", () => {
    expect(runwayMonths(9_000_000, 500_000)).toBeNull();
    expect(runwayMonths(9_000_000, 0)).toBeNull();
    expect(runwayMonths(null, -1_000_000)).toBeNull();
    expect(runwayMonths(9_000_000, null)).toBeNull();
  });
});

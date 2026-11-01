// Which months today's shelf valuation stands in for.
import { describe, it, expect } from "vitest";
import { monthsValuedLive, reliefDeltasByMonth } from "./inventoryRelief";

const MONTHS = ["2026-07", "2026-08", "2026-09", "2026-10", "2026-11"];

describe("monthsValuedLive", () => {
  it("covers the just-ended month until its snapshot exists", () => {
    // Snapshots through September; it is November 1st by the clock. October
    // ended but was never closed — today's shelf is its best figure.
    expect(monthsValuedLive({ "2026-08": 1, "2026-09": 1 }, MONTHS, "2026-11")).toEqual(["2026-10", "2026-11"]);
  });

  it("is only the live month once the previous one is closed", () => {
    expect(monthsValuedLive({ "2026-09": 1, "2026-10": 1 }, MONTHS, "2026-11")).toEqual(["2026-11"]);
  });

  it("never overrides a stored snapshot, and never reaches past the live month", () => {
    expect(monthsValuedLive({ "2026-11": 1 }, MONTHS, "2026-11")).toEqual([]);
    expect(monthsValuedLive({ "2026-08": 1 }, MONTHS, "2026-09")).toEqual(["2026-09"]);
    expect(monthsValuedLive({}, MONTHS, null)).toEqual([]);
  });

  it("a shelf with no snapshots at all is live from the first month asked for", () => {
    expect(monthsValuedLive({}, MONTHS, "2026-08")).toEqual(["2026-07", "2026-08"]);
  });
});

describe("reliefDeltasByMonth with a live-valued ended month", () => {
  it("books the ended month's change instead of zero", () => {
    const values = { "2026-09": 1_000, "2026-10": 1_400, "2026-11": 1_400 };
    const deltas = reliefDeltasByMonth(values, ["2026-10", "2026-11"], { excludeOpening: true });
    expect(deltas["2026-10"]).toBe(400);
    expect(deltas["2026-11"]).toBe(0);
  });
});

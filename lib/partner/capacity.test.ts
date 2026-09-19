import { describe, expect, it } from "vitest";
import { brewWindows, freeRanges, maxTurns, monthlyCapacity } from "./capacity";

const F40 = { id: "f40", capacity_bbl: 40 };
const F80 = { id: "f80", capacity_bbl: 80 };

describe("freeRanges", () => {
  it("returns the gaps between merged busy stretches", () => {
    expect(freeRanges([{ start: 5, end: 10 }, { start: 8, end: 12 }, { start: 20, end: 25 }], 0, 30)).toEqual([
      { start: 0, end: 5 }, { start: 12, end: 20 }, { start: 25, end: 30 },
    ]);
  });
  it("is the whole range when nothing is booked", () => {
    expect(freeRanges([], 3, 9)).toEqual([{ start: 3, end: 9 }]);
  });
});

describe("monthlyCapacity", () => {
  it("covers six calendar months starting with the first one anything can start in", () => {
    const rows = monthlyCapacity({ today: "2026-09-18", fermenters: [F40], busy: [], fermentDays: 14 });
    expect(rows.map((r) => r.month)).toEqual(["2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03"]);
  });

  it("never opens anything inside the two-week lead time, however empty the tank", () => {
    const rows = monthlyCapacity({ today: "2026-09-18", fermenters: [F40], busy: [], fermentDays: 14 });
    expect(rows[0]).toMatchObject({ month: "2026-10", open_slots: 1, earliest_start: "2026-10-02", max_turns: 2 });
    expect(rows[1]).toMatchObject({ open_slots: 1, earliest_start: "2026-11-01" });
    // Early in a month the lead time still lands inside it.
    expect(monthlyCapacity({ today: "2026-09-02", fermenters: [F40], busy: [], fermentDays: 14 })[0])
      .toMatchObject({ month: "2026-09", earliest_start: "2026-09-16" });
  });

  it("reads Full while every fermenter is booked, and opens the day one frees up", () => {
    const rows = monthlyCapacity({
      today: "2026-09-18", fermenters: [F40], fermentDays: 14,
      busy: [{ equipment_id: "f40", start: "2026-09-01", end: "2026-12-10" }],
    });
    expect(rows[0]).toMatchObject({ open_slots: 0, earliest_start: null, max_turns: 0 });
    expect(rows[1].open_slots).toBe(0);
    expect(rows[2]).toMatchObject({ open_slots: 1, earliest_start: "2026-12-10" });
  });

  it("does not count a gap shorter than one fermentation", () => {
    const rows = monthlyCapacity({
      today: "2026-09-18", fermenters: [F40], fermentDays: 14,
      busy: [{ equipment_id: "f40", start: "2026-10-12", end: "2027-06-01" }],
    });
    expect(rows.every((r) => r.open_slots === 0)).toBe(true);
  });

  it("does not read Full in the last month just because the brew would finish past the horizon", () => {
    const rows = monthlyCapacity({ today: "2026-09-18", fermenters: [F40], busy: [], fermentDays: 28 });
    expect(rows[5]).toMatchObject({ month: "2027-03", open_slots: 1, earliest_start: "2027-03-01" });
  });

  it("counts fermenters, and reports the largest brew an open one could hold", () => {
    const rows = monthlyCapacity({ today: "2026-09-18", fermenters: [F40, F80], busy: [], fermentDays: 14 });
    expect(rows[1]).toMatchObject({ open_slots: 2, max_turns: 4 });
  });
});

describe("brewWindows", () => {
  it("offers Mondays where a big-enough fermenter is free for the whole fermentation", () => {
    const w = brewWindows({
      today: "2026-09-18", fermenters: [F40, F80], fermentDays: 14, leadTimeDays: 21, turns: 4,
      busy: [{ equipment_id: "f80", start: "2026-09-01", end: "2026-10-14" }],
      limit: 2,
    });
    // f40 is free but too small for four turns; f80 frees up Oct 14 → Mon Oct 19.
    expect(w).toEqual([
      { week_of: "2026-10-19", ready_around: "2026-11-09" },
      { week_of: "2026-10-26", ready_around: "2026-11-16" },
    ]);
  });

  it("starts from the first Monday past the two-week lead time, and respects the limit", () => {
    const w = brewWindows({ today: "2026-09-18", fermenters: [F40], busy: [], fermentDays: 10, leadTimeDays: 10, turns: 1, limit: 3 });
    expect(w.map((x) => x.week_of)).toEqual(["2026-10-05", "2026-10-12", "2026-10-19"]);
  });
});

describe("maxTurns", () => {
  it("is the biggest fermenter in whole turns", () => {
    expect(maxTurns([F40, F80, { id: "x", capacity_bbl: null }])).toBe(4);
  });
});

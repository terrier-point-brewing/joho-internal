import { describe, it, expect } from "vitest";
import { computeNextPeriodDates, addDays } from "../periodUtils";

describe("computeNextPeriodDates", () => {
  it("biweekly: uses fallbackStart when no prior period", () => {
    const result = computeNextPeriodDates(null, "biweekly", "2026-01-05");
    expect(result.start_date).toBe("2026-01-05");
    expect(result.end_date).toBe("2026-01-18");
  });

  it("biweekly: starts the day after the last period's end", () => {
    const result = computeNextPeriodDates("2026-01-18", "biweekly");
    expect(result.start_date).toBe("2026-01-19");
    expect(result.end_date).toBe("2026-02-01");
  });

  it("weekly: 7-day period from fallbackStart", () => {
    const result = computeNextPeriodDates(null, "weekly", "2026-01-05");
    expect(result.start_date).toBe("2026-01-05");
    expect(result.end_date).toBe("2026-01-11");
  });

  it("weekly: advances one day after last end", () => {
    const result = computeNextPeriodDates("2026-01-11", "weekly");
    expect(result.start_date).toBe("2026-01-12");
    expect(result.end_date).toBe("2026-01-18");
  });
});

describe("addDays", () => {
  it("adds days correctly within a month", () => {
    expect(addDays("2026-01-18", 3)).toBe("2026-01-21");
  });

  it("crosses month boundary", () => {
    expect(addDays("2026-01-30", 5)).toBe("2026-02-04");
  });

  it("zero days returns same date", () => {
    expect(addDays("2026-06-15", 0)).toBe("2026-06-15");
  });
});

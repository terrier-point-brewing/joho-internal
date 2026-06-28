import { describe, it, expect } from "vitest";
import { computeNextPeriodDates, seedPeriodDates } from "../periodUtils";

describe("computeNextPeriodDates", () => {
  it("biweekly: uses anchor date when no prior periods", () => {
    const result = computeNextPeriodDates("2026-01-05", null, "biweekly");
    expect(result.start_date).toBe("2026-01-05");
    expect(result.end_date).toBe("2026-01-18");
  });

  it("biweekly: starts the day after the last period's end", () => {
    const result = computeNextPeriodDates("2026-01-05", "2026-01-18", "biweekly");
    expect(result.start_date).toBe("2026-01-19");
    expect(result.end_date).toBe("2026-02-01");
  });

  it("weekly: 7-day period from anchor", () => {
    const result = computeNextPeriodDates("2026-01-05", null, "weekly");
    expect(result.start_date).toBe("2026-01-05");
    expect(result.end_date).toBe("2026-01-11");
  });

  it("weekly: advances one day after last end", () => {
    const result = computeNextPeriodDates("2026-01-05", "2026-01-11", "weekly");
    expect(result.start_date).toBe("2026-01-12");
    expect(result.end_date).toBe("2026-01-18");
  });

  it("defaults to biweekly when frequency omitted", () => {
    const result = computeNextPeriodDates("2026-01-05", null);
    expect(result.end_date).toBe("2026-01-18");
  });
});

describe("seedPeriodDates", () => {
  it("biweekly: generates all periods from start through today", () => {
    const periods = seedPeriodDates("2026-01-05", "biweekly", "2026-02-01");
    expect(periods).toHaveLength(2);
    expect(periods[0]).toEqual({ start_date: "2026-01-05", end_date: "2026-01-18" });
    expect(periods[1]).toEqual({ start_date: "2026-01-19", end_date: "2026-02-01" });
  });

  it("weekly: generates correct 7-day periods", () => {
    const periods = seedPeriodDates("2026-01-05", "weekly", "2026-01-18");
    expect(periods).toHaveLength(2);
    expect(periods[0]).toEqual({ start_date: "2026-01-05", end_date: "2026-01-11" });
    expect(periods[1]).toEqual({ start_date: "2026-01-12", end_date: "2026-01-18" });
  });

  it("includes the period whose start is on throughDate", () => {
    const periods = seedPeriodDates("2026-01-05", "biweekly", "2026-01-05");
    expect(periods).toHaveLength(1);
    expect(periods[0].start_date).toBe("2026-01-05");
  });

  it("includes the period that straddles throughDate", () => {
    // throughDate falls in the middle of a period — that period must be included
    const periods = seedPeriodDates("2026-01-05", "biweekly", "2026-01-10");
    expect(periods).toHaveLength(1);
    expect(periods[0]).toEqual({ start_date: "2026-01-05", end_date: "2026-01-18" });
  });

  it("returns empty array when throughDate is before firstPeriodStartDate", () => {
    const periods = seedPeriodDates("2026-01-05", "biweekly", "2026-01-04");
    expect(periods).toHaveLength(0);
  });
});

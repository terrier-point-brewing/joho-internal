import { describe, it, expect } from "vitest";
import {
  monthPeriod,
  quarterPeriod,
  yearPeriod,
  periodContaining,
  lastDayOfFollowingMonth,
  addDaysIso,
} from "./period";

// All `ref` dates are anchored at UTC noon so the calendar day they represent
// cannot drift across a host timezone (max UTC offset is +/-14h, well under
// the 12h anchor). This mirrors the pattern in lib/utils/datetime.ts.
function refDate(iso: string): Date {
  return new Date(`${iso}T12:00:00Z`);
}

describe("monthPeriod", () => {
  it("returns first/last day of the ref month", () => {
    expect(monthPeriod(refDate("2026-06-15"))).toEqual({
      start: "2026-06-01",
      end: "2026-06-30",
    });
  });

  it("handles a 31-day month", () => {
    expect(monthPeriod(refDate("2026-07-04"))).toEqual({
      start: "2026-07-01",
      end: "2026-07-31",
    });
  });

  it("handles a year-boundary month (December)", () => {
    expect(monthPeriod(refDate("2026-12-05"))).toEqual({
      start: "2026-12-01",
      end: "2026-12-31",
    });
  });

  it("handles February in a leap year", () => {
    expect(monthPeriod(refDate("2028-02-10"))).toEqual({
      start: "2028-02-01",
      end: "2028-02-29",
    });
  });

  it("handles February in a non-leap year", () => {
    expect(monthPeriod(refDate("2026-02-10"))).toEqual({
      start: "2026-02-01",
      end: "2026-02-28",
    });
  });
});

describe("quarterPeriod", () => {
  it("returns Q2 bounds for a May ref date", () => {
    expect(quarterPeriod(refDate("2026-05-10"))).toEqual({
      start: "2026-04-01",
      end: "2026-06-30",
    });
  });

  it("returns Q1 bounds (year start)", () => {
    expect(quarterPeriod(refDate("2026-02-14"))).toEqual({
      start: "2026-01-01",
      end: "2026-03-31",
    });
  });

  it("returns Q4 bounds (year end)", () => {
    expect(quarterPeriod(refDate("2026-11-20"))).toEqual({
      start: "2026-10-01",
      end: "2026-12-31",
    });
  });
});

describe("yearPeriod", () => {
  it("returns full calendar year bounds", () => {
    expect(yearPeriod(refDate("2026-06-15"))).toEqual({
      start: "2026-01-01",
      end: "2026-12-31",
    });
  });
});

describe("periodContaining", () => {
  it("dispatches to monthPeriod for monthly", () => {
    expect(periodContaining("monthly", refDate("2026-06-15"))).toEqual(
      monthPeriod(refDate("2026-06-15")),
    );
  });

  it("dispatches to quarterPeriod for quarterly", () => {
    expect(periodContaining("quarterly", refDate("2026-05-10"))).toEqual(
      quarterPeriod(refDate("2026-05-10")),
    );
  });

  it("dispatches to yearPeriod for annual", () => {
    expect(periodContaining("annual", refDate("2026-05-10"))).toEqual(
      yearPeriod(refDate("2026-05-10")),
    );
  });
});

describe("lastDayOfFollowingMonth", () => {
  it("returns the last day of the month after a 30-day month", () => {
    expect(lastDayOfFollowingMonth("2026-06-30")).toBe("2026-07-31");
  });

  it("rolls over a year boundary", () => {
    expect(lastDayOfFollowingMonth("2026-12-31")).toBe("2027-01-31");
  });

  it("handles a leap-year February end", () => {
    expect(lastDayOfFollowingMonth("2028-01-31")).toBe("2028-02-29");
  });
});

describe("addDaysIso", () => {
  it("subtracts days within the same month", () => {
    expect(addDaysIso("2026-07-20", -7)).toBe("2026-07-13");
  });

  it("adds days across a month boundary", () => {
    expect(addDaysIso("2026-06-25", 10)).toBe("2026-07-05");
  });

  it("subtracts days across a year boundary", () => {
    expect(addDaysIso("2026-01-05", -10)).toBe("2025-12-26");
  });
});

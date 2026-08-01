// The period the connect-time check reads. Getting this wrong makes a healthy
// connection look broken: mid-month there is no month-end row to find, so
// checking the CURRENT month would fail for every working account.
import { describe, it, expect } from "vitest";
import { lastCompletedMonthEnd } from "./period";

describe("lastCompletedMonthEnd", () => {
  it("returns the previous month's last day, never a date in the current month", () => {
    expect(lastCompletedMonthEnd(new Date("2026-08-01T00:00:00Z"))).toBe("2026-07-31");
    expect(lastCompletedMonthEnd(new Date("2026-08-15T12:00:00Z"))).toBe("2026-07-31");
    expect(lastCompletedMonthEnd(new Date("2026-08-31T23:59:59Z"))).toBe("2026-07-31");
  });

  it("handles a 30-day month and a year boundary", () => {
    expect(lastCompletedMonthEnd(new Date("2026-07-04T00:00:00Z"))).toBe("2026-06-30");
    expect(lastCompletedMonthEnd(new Date("2026-01-10T00:00:00Z"))).toBe("2025-12-31");
  });

  it("handles February in a leap year", () => {
    expect(lastCompletedMonthEnd(new Date("2028-03-05T00:00:00Z"))).toBe("2028-02-29");
    expect(lastCompletedMonthEnd(new Date("2026-03-05T00:00:00Z"))).toBe("2026-02-28");
  });
});

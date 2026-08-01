// The period both the snapshot cron and the connect-time check resolve. They
// must agree; these pin the shared definition they now both call.
import { describe, it, expect } from "vitest";
import { mostRecentlyEndedMonthEnd } from "./periods";

describe("mostRecentlyEndedMonthEnd", () => {
  it("returns the previous month's last day, never a date in the current month", () => {
    // The current month is still in progress, so no month-end balance exists
    // for it and asking an integration for one fails on a healthy connection.
    expect(mostRecentlyEndedMonthEnd("2026-08-01")).toBe("2026-07-31");
    expect(mostRecentlyEndedMonthEnd("2026-08-15")).toBe("2026-07-31");
    expect(mostRecentlyEndedMonthEnd("2026-08-31")).toBe("2026-07-31");
  });

  it("handles a 30-day month and a year boundary", () => {
    expect(mostRecentlyEndedMonthEnd("2026-07-04")).toBe("2026-06-30");
    expect(mostRecentlyEndedMonthEnd("2026-01-10")).toBe("2025-12-31");
  });

  it("handles February in and out of a leap year", () => {
    expect(mostRecentlyEndedMonthEnd("2028-03-05")).toBe("2028-02-29");
    expect(mostRecentlyEndedMonthEnd("2026-03-05")).toBe("2026-02-28");
  });

  it("takes a date string, so the caller's timezone choice is explicit", () => {
    // The bug this module exists to close: the cron resolved "today" in the
    // brewery's timezone and the check used UTC, so on the evening of a month's
    // last day Eastern -- already the 1st in UTC -- they named different
    // periods. Taking an ISO date rather than a Date makes that unrepresentable.
    expect(mostRecentlyEndedMonthEnd("2026-07-31")).toBe("2026-06-30");
    expect(mostRecentlyEndedMonthEnd("2026-08-01")).toBe("2026-07-31");
  });
});

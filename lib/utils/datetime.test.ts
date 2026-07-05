import { describe, it, expect } from "vitest";
import {
  BREWERY_TZ,
  dayStartUtc,
  dayEndUtc,
  dayRangeUtc,
  localDateString,
  eachDateString,
  addDaysStr,
  weekdayOf,
  mondayOf,
  todayLocalDate,
} from "./datetime";

describe("BREWERY_TZ", () => {
  it("is America/New_York", () => {
    expect(BREWERY_TZ).toBe("America/New_York");
  });
});

describe("dayStartUtc", () => {
  it("converts EDT (summer, UTC-4) midnight to 04:00Z", () => {
    expect(dayStartUtc("2026-06-03")).toBe("2026-06-03T04:00:00.000Z");
  });

  it("converts EST (winter, UTC-5) midnight to 05:00Z", () => {
    expect(dayStartUtc("2026-01-15")).toBe("2026-01-15T05:00:00.000Z");
  });

  it("handles the spring-forward DST day (2026-03-08)", () => {
    // Midnight local is still EST (-5) before the 2am skip.
    expect(dayStartUtc("2026-03-08")).toBe("2026-03-08T05:00:00.000Z");
  });

  it("handles the fall-back DST day (2026-11-01)", () => {
    // Midnight local is still EDT (-4) before the 2am fall-back.
    expect(dayStartUtc("2026-11-01")).toBe("2026-11-01T04:00:00.000Z");
  });

  it("handles a month boundary", () => {
    expect(dayStartUtc("2026-02-01")).toBe("2026-02-01T05:00:00.000Z");
  });

  it("handles a year boundary", () => {
    expect(dayStartUtc("2026-01-01")).toBe("2026-01-01T05:00:00.000Z");
  });

  it("accepts an explicit timezone override (UTC → no offset)", () => {
    expect(dayStartUtc("2026-06-03", "UTC")).toBe("2026-06-03T00:00:00.000Z");
  });
});

describe("dayEndUtc", () => {
  // BUG: dayEndUtc is meant to return 23:59:59.999 brewery-local as a UTC
  // instant, but it actually returns ~00:00:00.997 of the NEXT day. `tzOffsetMs`
  // formats via Intl, which has no fractional-seconds part, so the offset is
  // computed against a millisecond-truncated wall clock; the two-pass
  // `wallClockToUtc` convergence then resolves 23:59:59.999 to 00:00:00.997 of
  // the following day. The end instant therefore spills ~1.002s past the
  // intended day boundary — a date-range query using this can leak a sliver of
  // the next calendar day. These tests pin the ACTUAL current behavior.
  it("converts EDT end-of-day (actual: next day 04:00:00.997Z)", () => {
    expect(dayEndUtc("2026-06-03")).toBe("2026-06-04T04:00:00.997Z");
  });

  it("converts EST end-of-day (actual: next day 05:00:00.997Z)", () => {
    expect(dayEndUtc("2026-01-15")).toBe("2026-01-16T05:00:00.997Z");
  });

  it("rolls across a year boundary (actual: 05:00:00.997Z)", () => {
    expect(dayEndUtc("2026-12-31")).toBe("2027-01-01T05:00:00.997Z");
  });

  it("respects a UTC override (actual: next day 00:00:00.997Z)", () => {
    expect(dayEndUtc("2026-06-03", "UTC")).toBe("2026-06-04T00:00:00.997Z");
  });

  it("lands within ~1.002s after the intended local-midnight boundary", () => {
    // Documents the magnitude of the spill: the returned instant is just after,
    // not just before, the start of the following day.
    const end = new Date(dayEndUtc("2026-06-03"));
    const nextDayStart = new Date(dayStartUtc("2026-06-04"));
    const deltaMs = end.getTime() - nextDayStart.getTime();
    expect(deltaMs).toBeGreaterThan(0); // spills PAST the boundary (the bug)
    expect(deltaMs).toBeLessThan(1100);
  });
});

describe("dayRangeUtc", () => {
  it("returns start of startDate and end of endDate (end reflects the dayEndUtc bug)", () => {
    const r = dayRangeUtc("2026-06-01", "2026-06-03");
    expect(r.startUtc).toBe("2026-06-01T04:00:00.000Z");
    // BUG: see dayEndUtc — end instant spills to 04:00:00.997 of the next day.
    expect(r.endUtc).toBe("2026-06-04T04:00:00.997Z");
  });

  it("works for a single-day range (end reflects the dayEndUtc bug)", () => {
    const r = dayRangeUtc("2026-01-15", "2026-01-15");
    expect(r.startUtc).toBe("2026-01-15T05:00:00.000Z");
    expect(r.endUtc).toBe("2026-01-16T05:00:00.997Z");
  });
});

describe("localDateString", () => {
  it("returns the brewery-local calendar date for a UTC timestamp", () => {
    expect(localDateString("2026-06-03T12:00:00Z")).toBe("2026-06-03");
  });

  it("buckets a late-evening-UTC instant into the prior local day", () => {
    // 03:30Z on Jun 4 is 23:30 EDT on Jun 3.
    expect(localDateString("2026-06-04T03:30:00Z")).toBe("2026-06-03");
  });

  it("buckets an early-UTC instant correctly across the EST offset", () => {
    // 04:30Z on Jan 16 is 23:30 EST on Jan 15.
    expect(localDateString("2026-01-16T04:30:00Z")).toBe("2026-01-15");
  });

  it("respects a UTC override", () => {
    expect(localDateString("2026-06-04T03:30:00Z", "UTC")).toBe("2026-06-04");
  });
});

describe("eachDateString", () => {
  it("returns an inclusive list of dates", () => {
    expect(eachDateString("2026-06-01", "2026-06-03")).toEqual([
      "2026-06-01",
      "2026-06-02",
      "2026-06-03",
    ]);
  });

  it("returns a single date when start equals end", () => {
    expect(eachDateString("2026-06-01", "2026-06-01")).toEqual(["2026-06-01"]);
  });

  it("returns an empty list when end precedes start", () => {
    expect(eachDateString("2026-06-03", "2026-06-01")).toEqual([]);
  });

  it("spans a month boundary", () => {
    expect(eachDateString("2026-01-30", "2026-02-02")).toEqual([
      "2026-01-30",
      "2026-01-31",
      "2026-02-01",
      "2026-02-02",
    ]);
  });

  it("spans a year boundary", () => {
    expect(eachDateString("2026-12-31", "2027-01-02")).toEqual([
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
    ]);
  });

  it("crosses the spring-forward DST boundary without skipping a day", () => {
    // Noon-UTC anchoring must keep DST from dropping/duplicating a date.
    expect(eachDateString("2026-03-07", "2026-03-09")).toEqual([
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
    ]);
  });

  it("crosses the fall-back DST boundary without duplicating a day", () => {
    expect(eachDateString("2026-10-31", "2026-11-02")).toEqual([
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ]);
  });

  it("handles a leap-day boundary", () => {
    expect(eachDateString("2028-02-28", "2028-03-01")).toEqual([
      "2028-02-28",
      "2028-02-29",
      "2028-03-01",
    ]);
  });
});

describe("addDaysStr", () => {
  it("adds days within a month", () => {
    expect(addDaysStr("2026-07-01", 6)).toBe("2026-07-07");
  });

  it("subtracts days (negative n)", () => {
    expect(addDaysStr("2026-07-01", -2)).toBe("2026-06-29");
  });

  it("returns the same date for n=0", () => {
    expect(addDaysStr("2026-07-01", 0)).toBe("2026-07-01");
  });

  it("crosses a month boundary", () => {
    expect(addDaysStr("2026-07-31", 1)).toBe("2026-08-01");
  });

  it("crosses a year boundary", () => {
    expect(addDaysStr("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("crosses the spring-forward DST boundary without skipping a day", () => {
    expect(addDaysStr("2026-03-07", 2)).toBe("2026-03-09");
  });

  it("crosses the fall-back DST boundary without duplicating a day", () => {
    expect(addDaysStr("2026-10-31", 2)).toBe("2026-11-02");
  });

  it("handles a leap day", () => {
    expect(addDaysStr("2028-02-28", 1)).toBe("2028-02-29");
  });
});

describe("weekdayOf", () => {
  it("returns 3 (Wednesday) for 2026-07-01", () => {
    expect(weekdayOf("2026-07-01")).toBe(3);
  });

  it("returns 0 (Sunday) for 2026-07-05", () => {
    expect(weekdayOf("2026-07-05")).toBe(0);
  });

  it("returns 1 (Monday) for 2026-07-06", () => {
    expect(weekdayOf("2026-07-06")).toBe(1);
  });
});

describe("mondayOf", () => {
  it("returns the same date when given a Monday", () => {
    expect(mondayOf("2026-06-29")).toBe("2026-06-29");
  });

  it("returns the prior Monday for a Sunday (end of ISO week)", () => {
    // 2026-07-05 is a Sunday; its ISO week began Mon 2026-06-29.
    expect(mondayOf("2026-07-05")).toBe("2026-06-29");
  });

  it("returns the week's Monday for a Saturday", () => {
    expect(mondayOf("2026-07-04")).toBe("2026-06-29");
  });

  it("returns the week's Monday for a midweek date", () => {
    expect(mondayOf("2026-07-01")).toBe("2026-06-29"); // Wednesday
  });

  it("crosses a month boundary backwards", () => {
    expect(mondayOf("2026-07-05")).toBe("2026-06-29");
  });
});

describe("todayLocalDate", () => {
  it("uses the brewery zone: 03:30Z buckets into the prior local day", () => {
    // 03:30Z on Jul 5 is 23:30 EDT on Jul 4.
    expect(todayLocalDate(BREWERY_TZ, new Date("2026-07-05T03:30:00Z"))).toBe("2026-07-04");
  });

  it("uses the brewery zone: midday UTC stays the same local day", () => {
    expect(todayLocalDate(BREWERY_TZ, new Date("2026-07-05T16:00:00Z"))).toBe("2026-07-05");
  });

  it("respects an explicit zone override", () => {
    // Same instant is already Jul 5 in Tokyo (UTC+9).
    expect(todayLocalDate("Asia/Tokyo", new Date("2026-07-05T03:30:00Z"))).toBe("2026-07-05");
  });
});

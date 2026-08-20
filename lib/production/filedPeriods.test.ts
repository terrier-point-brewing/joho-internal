import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  periodsCovering,
  isDateInFiledExcisePeriod,
  filedPeriodExplanation,
  type FiledPeriod,
} from "./filedPeriods";

const ncJuly: FiledPeriod = {
  filingKey: "nc_dor_beer_excise",
  periodStart: "2026-07-01",
  periodEnd: "2026-07-31",
  submittedOn: "2026-08-10",
};

describe("periodsCovering", () => {
  it("matches a date inside the period", () => {
    expect(periodsCovering("2026-07-30", [ncJuly])).toEqual([ncJuly]);
  });

  it("includes both endpoints", () => {
    // A shipment on the last day of the month IS in that month's return. Parsing
    // these into Date objects would introduce a timezone the filing does not
    // have and could push it into the next period.
    expect(periodsCovering("2026-07-01", [ncJuly])).toHaveLength(1);
    expect(periodsCovering("2026-07-31", [ncJuly])).toHaveLength(1);
  });

  it("excludes a date outside the period", () => {
    expect(periodsCovering("2026-08-01", [ncJuly])).toEqual([]);
    expect(periodsCovering("2026-06-30", [ncJuly])).toEqual([]);
  });

  it("tolerates a full timestamp", () => {
    expect(periodsCovering("2026-07-30T14:22:01.000Z", [ncJuly])).toHaveLength(1);
  });
});

/** Stub for the single tax_tasks read. */
function tasksStub(rows: unknown[] | null, error?: string): SupabaseClient {
  const builder = {
    select: () => builder,
    in: () => builder,
    lte: () => builder,
    gte: () => Promise.resolve({ data: rows, error: error ? { message: error } : null }),
  };
  return { from: () => builder } as unknown as SupabaseClient;
}

describe("isDateInFiledExcisePeriod", () => {
  it("reports filed when a covering task is completed", async () => {
    const check = await isDateInFiledExcisePeriod(
      tasksStub([
        { filing_key: "nc_dor_beer_excise", period_start: "2026-07-01", period_end: "2026-07-31", status: "completed", submitted_on: "2026-08-10" },
      ]),
      "2026-07-30",
    );
    expect(check.isFiled).toBe(true);
    expect(check.periods[0].filingKey).toBe("nc_dor_beer_excise");
  });

  it("reports filed on submitted_on even when the task is not marked complete", async () => {
    // The two are set at different moments — a return can be submitted days
    // before someone ticks the task off. Either means the number is out of our hands.
    const check = await isDateInFiledExcisePeriod(
      tasksStub([
        { filing_key: "ttb_beer_excise", period_start: "2026-07-01", period_end: "2026-09-30", status: "open", submitted_on: "2026-10-02" },
      ]),
      "2026-08-13",
    );
    expect(check.isFiled).toBe(true);
  });

  it("reports open when the covering task is untouched", async () => {
    const check = await isDateInFiledExcisePeriod(
      tasksStub([
        { filing_key: "ttb_beer_excise", period_start: "2026-07-01", period_end: "2026-09-30", status: "open", submitted_on: null },
      ]),
      "2026-08-13",
    );
    expect(check.isFiled).toBe(false);
    expect(check.periods).toEqual([]);
  });

  it("reports open when nothing covers the date", async () => {
    expect((await isDateInFiledExcisePeriod(tasksStub([]), "2026-08-13")).isFiled).toBe(false);
  });

  it("FAILS CLOSED when the read errors", async () => {
    // Being wrong toward 'filed' costs a reversal row nobody needed. Being wrong
    // the other way silently restates a return a government has on file.
    const check = await isDateInFiledExcisePeriod(tasksStub(null, "connection reset"), "2026-07-30");
    expect(check.isFiled).toBe(true);
  });
});

describe("filedPeriodExplanation", () => {
  it("returns null for an open period", () => {
    expect(filedPeriodExplanation({ isFiled: false, periods: [] })).toBeNull();
  });

  it("names the filing in plain language", () => {
    const note = filedPeriodExplanation({ isFiled: true, periods: [ncJuly] });
    expect(note).toMatch(/NC beer excise/);
    expect(note).toMatch(/reversal dated today/);
  });

  it("joins two filings readably", () => {
    const note = filedPeriodExplanation({
      isFiled: true,
      periods: [ncJuly, { ...ncJuly, filingKey: "ttb_beer_excise" }],
    });
    expect(note).toMatch(/NC beer excise and TTB beer excise/);
  });
});

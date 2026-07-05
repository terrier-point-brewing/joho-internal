import { describe, it, expect } from "vitest";
import { buildSalesWeekView, weekLabel, DAY_LABELS } from "./salesPulseWeek";

describe("DAY_LABELS", () => {
  it("runs Monday-first through Sunday", () => {
    expect(DAY_LABELS).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
  });
});

describe("weekLabel", () => {
  it("formats a Mon–Sun span independent of the runtime zone", () => {
    expect(weekLabel("2026-06-29")).toBe("Jun 29 – Jul 5");
  });

  it("spans a year boundary", () => {
    expect(weekLabel("2026-12-28")).toBe("Dec 28 – Jan 3");
  });
});

describe("buildSalesWeekView", () => {
  // Regression: a Saturday sale (2026-07-04) must map to the "Sat" column, never
  // "Sun". Before the fix the tab derived its week grid from the *browser's*
  // zone; an east-of-UTC viewer shifted curStart back a day, so July 4 landed at
  // index 6 ("Sun") and read as a July-5 sale. Pinning to brewery-local date
  // strings keeps the API's day buckets and the column labels in the same zone.
  const view = buildSalesWeekView("2026-06-29", "2026-07-05");

  it("keeps curStart on the given Monday and curEnd on Sunday", () => {
    expect(view.curStart).toBe("2026-06-29");
    expect(view.curEnd).toBe("2026-07-05");
  });

  it("maps July 4 to the Saturday column (index 5), never Sunday", () => {
    const jul4 = view.dayPills.find((p) => p.dateStr === "2026-07-04")!;
    expect(jul4.index).toBe(5);
    expect(jul4.label).toBe("Sat");

    const jul5 = view.dayPills.find((p) => p.dateStr === "2026-07-05")!;
    expect(jul5.index).toBe(6);
    expect(jul5.label).toBe("Sun");
  });

  it("aligns every pill's dateStr and label with its Mon-first index", () => {
    view.dayPills.forEach((p, i) => {
      expect(p.index).toBe(i);
      expect(p.label).toBe(DAY_LABELS[i]);
    });
  });

  it("computes the prior-week comparator range", () => {
    expect(view.priorStart).toBe("2026-06-22");
    expect(view.priorEnd).toBe("2026-06-28");
  });

  it("flags the current week when weekStart is the Monday of today", () => {
    expect(buildSalesWeekView("2026-06-29", "2026-07-05").isCurrentWeek).toBe(true);
    // today = next Monday → the shown week is no longer current
    expect(buildSalesWeekView("2026-06-29", "2026-07-06").isCurrentWeek).toBe(false);
  });

  it("clamps effectiveEnd to today for the current, partial week", () => {
    const partial = buildSalesWeekView("2026-06-29", "2026-07-02"); // today = Thu
    expect(partial.effectiveEnd).toBe("2026-07-02");
    expect(partial.isCurrentWeek).toBe(true);
  });

  it("uses the full Sunday end when viewing a past week", () => {
    const past = buildSalesWeekView("2026-06-22", "2026-07-05");
    expect(past.effectiveEnd).toBe("2026-06-28");
    expect(past.isCurrentWeek).toBe(false);
  });

  it("marks only days after today as future", () => {
    const v = buildSalesWeekView("2026-06-29", "2026-07-02"); // today = Thu Jul 2
    const future = v.dayPills.filter((p) => p.isFuture).map((p) => p.dateStr);
    expect(future).toEqual(["2026-07-03", "2026-07-04", "2026-07-05"]);
  });
});

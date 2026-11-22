/**
 * The close alert exists so nobody has to press Close to find out why it will
 * refuse. These pin the three ways it used to stay quiet: a month older than
 * the latest one, a duplicate nobody was told about, and a recalculation that
 * fails on some nights.
 */
import { describe, it, expect } from "vitest";
import { duplicatesByBlockedPeriod, recalculationTrouble, unclosedPeriodEnds, MAX_OPEN_PERIODS, type CloseEvent } from "./closeReadiness";

const closed = (period_end: string, created_at = `${period_end}T12:00:00Z`): CloseEvent => ({ period_end, action: "closed", created_at });
const reopened = (period_end: string, created_at: string): CloseEvent => ({ period_end, action: "reopened", created_at });

describe("unclosedPeriodEnds", () => {
  it("lists the month after the last close", () => {
    expect(unclosedPeriodEnds([closed("2026-08-31"), closed("2026-09-30")], "2026-11-22")).toEqual(["2026-10-31"]);
  });

  it("keeps an older month once a newer one has ended", () => {
    // The old alert went quiet about October on 1 December.
    expect(unclosedPeriodEnds([closed("2026-09-30")], "2026-12-03")).toEqual(["2026-10-31", "2026-11-30"]);
  });

  it("is empty when the latest ended month is closed", () => {
    expect(unclosedPeriodEnds([closed("2026-10-31")], "2026-11-22")).toEqual([]);
  });

  it("never lists the month still in progress", () => {
    expect(unclosedPeriodEnds([closed("2026-10-31")], "2026-11-30")).toEqual([]);
  });

  it("crosses a year end", () => {
    expect(unclosedPeriodEnds([closed("2026-11-30")], "2027-02-10")).toEqual(["2026-12-31", "2027-01-31"]);
  });

  it("reads a period's state off its most recent event", () => {
    const events = [
      closed("2026-04-30", "2026-09-01T00:00:00Z"),
      reopened("2026-04-30", "2026-09-09T00:00:00Z"),
      closed("2026-10-31"),
    ];
    expect(unclosedPeriodEnds(events, "2026-11-22")).toEqual(["2026-04-30"]);
  });

  it("does not count a reopened-then-reclosed month", () => {
    const events = [
      closed("2026-04-30", "2026-09-01T00:00:00Z"),
      reopened("2026-04-30", "2026-09-09T00:00:00Z"),
      closed("2026-04-30", "2026-09-12T00:00:00Z"),
      closed("2026-10-31"),
    ];
    expect(unclosedPeriodEnds(events, "2026-11-22")).toEqual([]);
  });

  it("falls back to the latest ended month when nothing was ever closed", () => {
    expect(unclosedPeriodEnds([], "2026-11-22")).toEqual(["2026-10-31"]);
  });

  it("caps a long backlog at the newest months", () => {
    const out = unclosedPeriodEnds([closed("2024-01-31")], "2026-11-22");
    expect(out).toHaveLength(MAX_OPEN_PERIODS);
    expect(out[out.length - 1]).toBe("2026-10-31");
  });
});

describe("recalculationTrouble", () => {
  const ok = { errors: [] };
  const bad = (msg = "timeout") => ({ errors: [msg] });

  it("is quiet when every night was clean", () => {
    expect(recalculationTrouble([ok, ok, ok])).toBeNull();
  });

  it("is quiet with no runs at all", () => {
    expect(recalculationTrouble([])).toBeNull();
  });

  it("ignores one bad night that has since passed", () => {
    expect(recalculationTrouble([ok, ok, bad(), ok])).toBeNull();
  });

  it("reports when the most recent night failed", () => {
    expect(recalculationTrouble([bad("gift cards"), ok, ok])).toEqual({ failed: 1, of: 3, latestError: "gift cards" });
  });

  it("reports an intermittent failure even after a clean night", () => {
    // October 2026: 8 failures in 22, never two nights the same.
    expect(recalculationTrouble([ok, bad("newest"), ok, bad("older"), ok, ok, ok])).toEqual({ failed: 2, of: 7, latestError: "newest" });
  });
});

describe("duplicatesByBlockedPeriod", () => {
  it("gives each duplicate to the first open month it blocks", () => {
    const out = duplicatesByBlockedPeriod(["2026-10-31", "2026-10-31", "2026-11-30"], ["2026-10-31", "2026-11-30"]);
    expect(Object.fromEntries(out)).toEqual({ "2026-10-31": 2, "2026-11-30": 1 });
  });

  it("counts a duplicate from a closed month against the oldest open one", () => {
    const out = duplicatesByBlockedPeriod(["2026-06-30"], ["2026-10-31", "2026-11-30"]);
    expect(Object.fromEntries(out)).toEqual({ "2026-10-31": 1 });
  });

  it("leaves out a duplicate dated after every open month", () => {
    // A November pair does not block October.
    expect(duplicatesByBlockedPeriod(["2026-11-30"], ["2026-10-31"]).size).toBe(0);
  });
});

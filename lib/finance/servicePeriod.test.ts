import { describe, expect, it } from "vitest";
import {
  deferredAfter,
  fullMonthRateCents,
  isSpreadableAccountType,
  recognitionByMonth,
  serviceMonthWeights,
  servicePeriodMonths,
  spreadOverServicePeriod,
  validateServicePeriod,
} from "./servicePeriod";

const YEAR = { start: "2026-01-01", end: "2026-12-31" };
const sum = (allocs: { amountCents: number }[]) => allocs.reduce((s, a) => s + a.amountCents, 0);

describe("serviceMonthWeights", () => {
  it("gives every fully covered month the same weight, February included", () => {
    const weights = serviceMonthWeights(YEAR);
    expect(weights).toHaveLength(12);
    expect(weights.every((w) => w.weight === 1)).toBe(true);
  });

  it("weights a partly covered month by the share of it covered", () => {
    const weights = serviceMonthWeights({ start: "2026-05-16", end: "2026-07-31" });
    expect(weights.map((w) => w.monthKey)).toEqual(["2026-05", "2026-06", "2026-07"]);
    expect(weights[0].weight).toBeCloseTo(16 / 31);
    expect(weights[1].weight).toBe(1);
  });

  it("crosses a year end", () => {
    expect(serviceMonthWeights({ start: "2026-11-01", end: "2027-02-28" }).map((w) => w.monthKey)).toEqual([
      "2026-11", "2026-12", "2027-01", "2027-02",
    ]);
  });
});

describe("spreadOverServicePeriod", () => {
  it("splits a yearly bill into twelve equal months that sum to the bill exactly", () => {
    const allocs = spreadOverServicePeriod(-829_944, YEAR);
    expect(sum(allocs)).toBe(-829_944);
    expect(new Set(allocs.map((a) => a.amountCents))).toEqual(new Set([-69_162]));
  });

  it("hands leftover cents out one at a time and still sums exactly", () => {
    const allocs = spreadOverServicePeriod(-100_000, YEAR);
    expect(sum(allocs)).toBe(-100_000);
    for (const a of allocs) expect([-8_333, -8_334]).toContain(a.amountCents);
  });

  it("keeps the sign of a credit", () => {
    const allocs = spreadOverServicePeriod(1_200, YEAR);
    expect(allocs.every((a) => a.amountCents === 100)).toBe(true);
  });
});

describe("recognitionByMonth", () => {
  it("charges the months before the bill arrived in the bill's own month", () => {
    // A 2026 bill dated in November: January-November catch up, December is deferred.
    const allocs = recognitionByMonth(-829_944, YEAR, "2026-11");
    expect(allocs).toEqual([
      { monthKey: "2026-11", amountCents: -69_162 * 11 },
      { monthKey: "2026-12", amountCents: -69_162 },
    ]);
  });

  it("spreads a bill paid ahead evenly, with nothing to catch up", () => {
    const allocs = recognitionByMonth(-120_000, { start: "2026-11-01", end: "2027-10-31" }, "2026-11");
    expect(allocs).toHaveLength(12);
    expect(allocs.every((a) => a.amountCents === -10_000)).toBe(true);
  });

  it("books a bill for months already over entirely in its own month", () => {
    expect(recognitionByMonth(-90_000, { start: "2026-01-01", end: "2026-03-31" }, "2026-06")).toEqual([
      { monthKey: "2026-06", amountCents: -90_000 },
    ]);
  });

  it("never recognises anything before the bill's month", () => {
    const allocs = recognitionByMonth(-829_944, YEAR, "2026-11");
    expect(allocs.every((a) => a.monthKey >= "2026-11")).toBe(true);
    expect(sum(allocs)).toBe(-829_944);
  });
});

describe("deferredAfter", () => {
  it("is what the P&L has not recognised yet, and reaches zero at the period's end", () => {
    const period = { start: "2026-11-01", end: "2027-10-31" };
    expect(deferredAfter(-120_000, period, "2026-11", "2026-11")).toBe(-110_000);
    expect(deferredAfter(-120_000, period, "2026-11", "2027-04")).toBe(-60_000);
    expect(deferredAfter(-120_000, period, "2026-11", "2027-10")).toBe(0);
  });

  it("plus what has been recognised always equals the bill", () => {
    for (const through of ["2026-11", "2026-12", "2027-01"]) {
      const recognised = sum(recognitionByMonth(-829_944, YEAR, "2026-11").filter((a) => a.monthKey <= through));
      expect(recognised + deferredAfter(-829_944, YEAR, "2026-11", through)).toBe(-829_944);
    }
  });
});

describe("rates", () => {
  it("reports one month's share and the renewal interval", () => {
    expect(fullMonthRateCents(-829_944, YEAR)).toBeCloseTo(-69_162);
    expect(servicePeriodMonths(YEAR)).toBe(12);
    expect(servicePeriodMonths({ start: "2026-05-16", end: "2026-07-31" })).toBe(3);
  });
});

describe("validateServicePeriod", () => {
  it("accepts a multi-month range", () => {
    expect(validateServicePeriod(YEAR)).toEqual({ ok: true });
  });

  it.each([
    [{ start: "", end: "" }],
    [{ start: "2026-02-30", end: "2026-12-31" }],
    [{ start: "2026-12-31", end: "2026-01-01" }],
    [{ start: "2026-03-01", end: "2026-03-31" }],
    [{ start: "2016-01-01", end: "2026-12-31" }],
    [{ start: 20260101, end: null }],
  ])("refuses %j", (period) => {
    expect(validateServicePeriod(period).ok).toBe(false);
  });
});

describe("isSpreadableAccountType", () => {
  it("spreads income and cost accounts and nothing on the balance sheet", () => {
    for (const type of ["Expenses", "Cost of Goods Sold", "Income", "Other Income", "Other Expense"]) {
      expect(isSpreadableAccountType(type)).toBe(true);
    }
    for (const type of ["Fixed Assets", "Other Current Assets", "Accounts payable (A/P)", "Equity", "Not A Type", null, undefined]) {
      expect(isSpreadableAccountType(type)).toBe(false);
    }
  });
});

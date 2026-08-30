import { describe, it, expect } from "vitest";
import { computeDepreciationSeries, expenseThroughMonth, type LifeRevision } from "./engine";

const INCEPTION_84: LifeRevision[] = [{ effectiveMonth: null, lifeMonths: 84 }];

describe("computeDepreciationSeries — plain straight line", () => {
  it("charges basis/life monthly and terminates at exactly zero book value", () => {
    // $8,400 over 84 months = $100/month, no rounding drama.
    const s = computeDepreciationSeries([{ month: "2026-04", cents: 840_000 }], INCEPTION_84, "2033-03");
    expect(s.expenseCentsByMonth["2026-04"]).toBe(-10_000);
    expect(s.expenseCentsByMonth["2033-03"]).toBe(-10_000);
    expect(s.expenseCentsByMonth["2033-04"]).toBeUndefined();
    expect(s.accumulatedCents).toBe(-840_000);
  });

  it("rounding self-corrects: the final month absorbs the residual to the cent", () => {
    // $1,000.00 over 7 months does not divide evenly.
    const s = computeDepreciationSeries([{ month: "2026-01", cents: 100_000 }], [{ effectiveMonth: null, lifeMonths: 7 }], "2026-07");
    const total = Object.values(s.expenseCentsByMonth).reduce((a, b) => a + b, 0);
    expect(total).toBe(-100_000);
    expect(s.accumulatedCents).toBe(-100_000);
  });

  it("depreciation starts the month of the addition (full-month convention)", () => {
    const s = computeDepreciationSeries([{ month: "2026-04", cents: 840_000 }], INCEPTION_84, "2026-04");
    expect(s.accumulatedCents).toBe(-10_000);
  });

  it("stops accruing at throughMonth without forcing the remainder", () => {
    const s = computeDepreciationSeries([{ month: "2026-04", cents: 840_000 }], INCEPTION_84, "2026-08");
    expect(s.accumulatedCents).toBe(-50_000); // 5 months
  });

  it("each month's additions run their own clock", () => {
    const s = computeDepreciationSeries(
      [
        { month: "2026-01", cents: 120_000 }, // $100/mo over 12
        { month: "2026-07", cents: 120_000 },
      ],
      [{ effectiveMonth: null, lifeMonths: 12 }],
      "2026-12",
    );
    expect(s.expenseCentsByMonth["2026-06"]).toBe(-10_000); // only the first
    expect(s.expenseCentsByMonth["2026-07"]).toBe(-20_000); // both
    expect(s.accumulatedCents).toBe(-(12 * 10_000 + 6 * 10_000));
  });
});

describe("computeDepreciationSeries — prospective life revisions", () => {
  // ASC 250: NBV at the change spreads over the remaining NEW life. History
  // is never restated — the months before the revision keep their old charge.
  it("re-spreads remaining book value from the revision month, leaving history alone", () => {
    // $1,200 over 12 months; after 4 months ($400 charged, $800 NBV) the life
    // doubles to 24. Remaining = 24 - 4 = 20 months → $40/month.
    const s = computeDepreciationSeries(
      [{ month: "2026-01", cents: 120_000 }],
      [
        { effectiveMonth: null, lifeMonths: 12 },
        { effectiveMonth: "2026-05", lifeMonths: 24 },
      ],
      "2026-06",
    );
    expect(s.expenseCentsByMonth["2026-04"]).toBe(-10_000); // old life, untouched
    expect(s.expenseCentsByMonth["2026-05"]).toBe(-4_000);  // 80,000 / 20
    expect(s.expenseCentsByMonth["2026-06"]).toBe(-4_000);
  });

  it("a life shortened below the asset's age charges the whole NBV in the change month", () => {
    // 12-month life, revised to 3 months when the asset is already 6 old.
    const s = computeDepreciationSeries(
      [{ month: "2026-01", cents: 120_000 }],
      [
        { effectiveMonth: null, lifeMonths: 12 },
        { effectiveMonth: "2026-07", lifeMonths: 3 },
      ],
      "2026-12",
    );
    expect(s.expenseCentsByMonth["2026-07"]).toBe(-60_000); // the remaining half
    expect(s.expenseCentsByMonth["2026-08"]).toBeUndefined();
    expect(s.accumulatedCents).toBe(-120_000);
  });

  it("the revision only touches additions still carrying book value", () => {
    // Fully depreciated before the revision: nothing to re-spread.
    const s = computeDepreciationSeries(
      [{ month: "2026-01", cents: 1_200 }],
      [
        { effectiveMonth: null, lifeMonths: 2 },
        { effectiveMonth: "2026-06", lifeMonths: 60 },
      ],
      "2026-12",
    );
    expect(s.accumulatedCents).toBe(-1_200);
    expect(s.expenseCentsByMonth["2026-06"]).toBeUndefined();
  });
});

describe("computeDepreciationSeries — edges", () => {
  it("a negative addition unwinds expense at the same rate", () => {
    const s = computeDepreciationSeries(
      [
        { month: "2026-01", cents: 120_000 },
        { month: "2026-01", cents: -120_000 },
      ],
      [{ effectiveMonth: null, lifeMonths: 12 }],
      "2026-12",
    );
    expect(s.accumulatedCents).toBe(0);
    expect(Object.values(s.expenseCentsByMonth).every((c) => c === 0) || Object.keys(s.expenseCentsByMonth).length === 0).toBe(true);
  });

  it("an ended schedule holds accumulated constant instead of vanishing", () => {
    const s = computeDepreciationSeries([{ month: "2026-01", cents: 120_000 }], [{ effectiveMonth: null, lifeMonths: 12 }], "2026-12", "2026-03");
    expect(s.accumulatedCents).toBe(-30_000); // 3 months, then stopped
    expect(s.expenseCentsByMonth["2026-04"]).toBeUndefined();
  });

  it("tiny book values are not stranded by rounding to zero", () => {
    // 3 cents over 60 months rounds to 0 every month until the final one.
    const s = computeDepreciationSeries([{ month: "2026-01", cents: 3 }], [{ effectiveMonth: null, lifeMonths: 60 }], "2030-12");
    expect(s.accumulatedCents).toBe(-3);
  });

  it("additions after throughMonth contribute nothing", () => {
    const s = computeDepreciationSeries([{ month: "2027-01", cents: 120_000 }], INCEPTION_84, "2026-12");
    expect(s.accumulatedCents).toBe(0);
  });

  it("expenseThroughMonth sums only the months at or before the cutoff", () => {
    const s = computeDepreciationSeries([{ month: "2026-01", cents: 120_000 }], [{ effectiveMonth: null, lifeMonths: 12 }], "2026-12");
    expect(expenseThroughMonth(s, "2026-03")).toBe(-30_000);
    expect(expenseThroughMonth(s, "2026-12")).toBe(-120_000);
  });
});

import { describe, it, expect } from "vitest";
import { prorateAcrossMonths } from "./payrollPeriodProration";

describe("prorateAcrossMonths", () => {
  it("splits an exact 50/50 across a 7+7 day period spanning May/June", () => {
    const result = prorateAcrossMonths(-42000, "2026-05-25", "2026-06-07");
    expect(result).toEqual([
      { monthKey: "2026-05", amountCents: -21000 },
      { monthKey: "2026-06", amountCents: -21000 },
    ]);
  });

  it("prorates an uneven 10+4 day split with largest-remainder rounding, summing exactly to the original amount", () => {
    const result = prorateAcrossMonths(-100000, "2026-05-22", "2026-06-04"); // May 22-31 = 10 days, Jun 1-4 = 4 days
    expect(result).toEqual([
      { monthKey: "2026-05", amountCents: -71429 },
      { monthKey: "2026-06", amountCents: -28571 },
    ]);
    const sum = result.reduce((s, r) => s + r.amountCents, 0);
    expect(sum).toBe(-100000);
  });

  it("returns a single entry for a period entirely within one month", () => {
    const result = prorateAcrossMonths(-5000, "2026-06-01", "2026-06-14");
    expect(result).toEqual([{ monthKey: "2026-06", amountCents: -5000 }]);
  });

  it("handles a period spanning 3 calendar months", () => {
    const result = prorateAcrossMonths(-3400, "2026-05-30", "2026-07-02"); // May 30-31 = 2 days, Jun 1-30 = 30 days, Jul 1-2 = 2 days (34 total)
    expect(result).toEqual([
      { monthKey: "2026-05", amountCents: -200 },
      { monthKey: "2026-06", amountCents: -3000 },
      { monthKey: "2026-07", amountCents: -200 },
    ]);
    const sum = result.reduce((s, r) => s + r.amountCents, 0);
    expect(sum).toBe(-3400);
  });

  it("breaks an exact tie by keeping the earlier month first (stable order), summing exactly to the original odd-cent amount", () => {
    const result = prorateAcrossMonths(-100001, "2026-05-25", "2026-06-07"); // 7+7 days, -50000.5 each before rounding
    expect(result).toEqual([
      { monthKey: "2026-05", amountCents: -50001 },
      { monthKey: "2026-06", amountCents: -50000 },
    ]);
    const sum = result.reduce((s, r) => s + r.amountCents, 0);
    expect(sum).toBe(-100001);
  });
});

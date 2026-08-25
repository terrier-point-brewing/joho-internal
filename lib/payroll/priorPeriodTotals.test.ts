import { describe, it, expect } from "vitest";
import { computeSnapshotTotals } from "./priorPeriodTotals";

const E = (o: Partial<Parameters<typeof computeSnapshotTotals>[0][number]>) => ({
  hours_worked: null, paycheck_tips_cents: null, cash_tips_cents: null,
  reported_cash_tips_cents: null, bonus_cents: null, ...o,
});

describe("computeSnapshotTotals", () => {
  it("returns null with no snapshot rows (period never locked)", () => {
    expect(computeSnapshotTotals([], 1500)).toBeNull();
  });

  it("rounds base pay once per entry, on that entry's summed hours", () => {
    // 10.005h × $15.00 = 15007.5c → 15008c per entry, not summed-then-rounded
    const t = computeSnapshotTotals([E({ hours_worked: 10.005 }), E({ hours_worked: 10.005 })], 1500)!;
    expect(t.basePayCents).toBe(30016);
    expect(t.hours).toBeCloseTo(20.01, 5);
  });

  it("splits total comp by cash-tips basis", () => {
    const t = computeSnapshotTotals(
      [E({ hours_worked: 10, paycheck_tips_cents: 500, cash_tips_cents: 900, reported_cash_tips_cents: 300, bonus_cents: 200 })],
      1000,
    )!;
    expect(t.totalCompCents).toBe(10000 + 500 + 200 + 900);
    expect(t.reportedTotalCompCents).toBe(10000 + 500 + 200 + 300);
  });

  it("falls back to actual cash tips when the snapshot predates reported tips", () => {
    const t = computeSnapshotTotals([E({ cash_tips_cents: 750 })], 1000)!;
    expect(t.reportedCashTipsCents).toBe(750);
  });
});

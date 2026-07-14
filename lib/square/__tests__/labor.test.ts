import { describe, it, expect } from "vitest";
import { aggregateDailyShifts } from "../labor";

describe("aggregateDailyShifts", () => {
  it("sums declared cash tips per member per day across shifts", () => {
    const rows = aggregateDailyShifts([
      { employee_id: "A", start_at: "2026-07-01T11:00:00-04:00", end_at: "2026-07-01T15:00:00-04:00", declared_cash_tip_money: { amount: 500 } },
      { employee_id: "A", start_at: "2026-07-01T17:00:00-04:00", end_at: "2026-07-01T20:00:00-04:00", declared_cash_tip_money: { amount: 300 } },
      { employee_id: "A", start_at: "2026-07-02T11:00:00-04:00", end_at: "2026-07-02T15:00:00-04:00" }, // no declaration → 0
    ]);
    const jul1 = rows.find(r => r.team_member_id === "A" && r.date === "2026-07-01")!;
    const jul2 = rows.find(r => r.team_member_id === "A" && r.date === "2026-07-02")!;
    expect(jul1.cash_tips_cents).toBe(800);
    expect(jul1.hours).toBeCloseTo(7);
    expect(jul2.cash_tips_cents).toBe(0);
  });

  it("skips open shifts (no end_at)", () => {
    const rows = aggregateDailyShifts([
      { employee_id: "B", start_at: "2026-07-01T11:00:00-04:00", end_at: null, declared_cash_tip_money: { amount: 999 } },
    ]);
    expect(rows).toHaveLength(0);
  });
});

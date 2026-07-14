import { describe, it, expect } from "vitest";
import { computePayrollEntries, mergeAdjustments, GuaranteeBucket } from "../calculations";
import type { Employee, PayrollConfig } from "../types";

const config: PayrollConfig = {
  id: "c1",
  effective_from: "2026-01-01",
  base_rate_cents: 1000,       // $10/hr
  guaranteed_rate_cents: 1500, // $15/hr guaranteed
  reported_cash_tips_divisor: 10,
  tip_distribution_model: "proportional_hours",
  tip_pool_frequency: "biweekly",
  guaranteed_min_frequency: "biweekly",
  pay_period_frequency: "biweekly",
  due_date_days_after_end: 3,
  created_at: "2026-01-01T00:00:00Z",
};

const mkEmployee = (id: string, sqId: string): Employee => ({
  id,
  first_name: "A",
  last_name: "B",
  email: "a@b.com",
  phone_number: null,
  job_title: "Bartender",
  employment_type: "hourly",
  receives_tips: true,
  square_team_member_id: sqId,
  gusto_employee_id: null,
  active: true,
  created_at: "2026-01-01T00:00:00Z",
});

/**
 * Helper that mirrors previewService's attribution logic for a single bucket:
 * distributes pooledTips and cashTipsTotal proportionally by hour share.
 * cashTipsTotal is the already-rate-applied amount (cash_tips_rate × cash_take).
 */
function oneGuaranteeBucket(
  shifts: Map<string, number>,
  pooledTips: number,
  cashTipsTotal: number,
): GuaranteeBucket[] {
  const totalHours = [...shifts.values()].reduce((s, h) => s + h, 0);
  const paycheckTipsCents = new Map<string, number>();
  const cashTipsCents = new Map<string, number>();
  for (const [id, h] of shifts) {
    const share = totalHours > 0 ? h / totalHours : 0;
    paycheckTipsCents.set(id, Math.round(share * pooledTips));
    cashTipsCents.set(id, Math.round(share * cashTipsTotal));
  }
  return [{ shifts, paycheckTipsCents, cashTipsCents }];
}

describe("computePayrollEntries", () => {
  it("distributes tips proportionally by hours", () => {
    const employees = [mkEmployee("e1", "sq1"), mkEmployee("e2", "sq2")];
    const shifts = new Map([["sq1", 30], ["sq2", 10]]); // 75% / 25%
    const results = computePayrollEntries(employees, oneGuaranteeBucket(shifts, 10000, 0), config);
    const e1 = results.find((r) => r.employee_id === "e1")!;
    const e2 = results.find((r) => r.employee_id === "e2")!;
    expect(e1.paycheck_tips_cents).toBe(7500);
    expect(e2.paycheck_tips_cents).toBe(2500);
  });

  it("passes declared cash tips straight through per employee", () => {
    const employees = [mkEmployee("e1", "sq1")];
    const shifts = new Map([["sq1", 10]]);
    // declared cash of 1000c attributed to e1's bucket
    const results = computePayrollEntries(employees, oneGuaranteeBucket(shifts, 0, 1000), config);
    expect(results[0].cash_tips_cents).toBe(1000);
  });

  it("derives reported cash tips = round(actual / divisor); divisor never touches bonus", () => {
    const employees = [mkEmployee("e1", "sq1")];
    const shifts = new Map([["sq1", 10]]);
    // base_pay = 10*1000 = 10000, guaranteed = 10*1500 = 15000, actual cash = 3000
    // bonus = max(0, 15000 - 10000 - 3000) = 2000 (independent of divisor)
    const r10 = computePayrollEntries(employees, oneGuaranteeBucket(shifts, 0, 3000), { ...config, reported_cash_tips_divisor: 10 });
    const r5 = computePayrollEntries(employees, oneGuaranteeBucket(shifts, 0, 3000), { ...config, reported_cash_tips_divisor: 5 });
    expect(r10[0].cash_tips_cents).toBe(3000);
    expect(r10[0].reported_cash_tips_cents).toBe(300); // round(3000/10)
    expect(r5[0].reported_cash_tips_cents).toBe(600);   // round(3000/5)
    expect(r10[0].bonus_cents).toBe(2000);
    expect(r5[0].bonus_cents).toBe(2000);               // bonus uses actual cash, not reported
  });

  it("computes bonus when tips don't meet guaranteed rate", () => {
    const employees = [mkEmployee("e1", "sq1")];
    const shifts = new Map([["sq1", 10]]);
    // base_pay = 10 * 1000 = 10000
    // guaranteed = 10 * 1500 = 15000
    // paycheck_tips = 0, cash_tips = 0
    // bonus = 15000 - 10000 - 0 - 0 = 5000
    const results = computePayrollEntries(employees, oneGuaranteeBucket(shifts, 0, 0), config);
    expect(results[0].bonus_cents).toBe(5000);
  });

  it("bonus is zero when tips exceed guaranteed rate", () => {
    const employees = [mkEmployee("e1", "sq1")];
    const shifts = new Map([["sq1", 10]]);
    // paycheck_tips = 10000, base_pay = 10000, guaranteed = 15000
    // 10000 + 10000 = 20000 > 15000, so bonus = 0
    const results = computePayrollEntries(employees, oneGuaranteeBucket(shifts, 10000, 0), config);
    expect(results[0].bonus_cents).toBe(0);
  });

  it("excludes employees without square_team_member_id", () => {
    const emp: Employee = { ...mkEmployee("e1", ""), square_team_member_id: null };
    const results = computePayrollEntries([emp], oneGuaranteeBucket(new Map(), 0, 0), config);
    expect(results).toHaveLength(0);
  });

  it("returns zero hours for employees not in shifts map", () => {
    const employees = [mkEmployee("e1", "sq1")];
    const results = computePayrollEntries(employees, oneGuaranteeBucket(new Map(), 0, 0), config);
    expect(results[0].hours_worked).toBe(0);
  });

  it("sums bonus across multiple guarantee buckets", () => {
    const employees = [mkEmployee("e1", "sq1")];
    // Two weekly buckets: 5h each, no tips — each week falls short of guarantee
    // Per bucket: guaranteed = 5*1500=7500, base_pay = 5*1000=5000, bonus = 2500
    // Total bonus = 5000
    const buckets: GuaranteeBucket[] = [
      { shifts: new Map([["sq1", 5]]), paycheckTipsCents: new Map(), cashTipsCents: new Map() },
      { shifts: new Map([["sq1", 5]]), paycheckTipsCents: new Map(), cashTipsCents: new Map() },
    ];
    const results = computePayrollEntries(employees, buckets, config);
    expect(results[0].bonus_cents).toBe(5000);
  });

  it("bonus respects guarantee granularity (weekly tips / daily guarantee)", () => {
    // Week pool: $100 total, emp works 5h Mon + 5h Tue = 10h (only employee)
    // Daily tip attribution: Mon = $50, Tue = $50
    // Daily guarantee = 5h * $15 = $75
    // Daily base pay = 5h * $10 = $50
    // Mon: $75 - $50 - $50 = -$25 → bonus = $0 (tips cover it)
    // Tue: same → bonus = $0
    // Total bonus = $0
    const employees = [mkEmployee("e1", "sq1")];
    const buckets: GuaranteeBucket[] = [
      { shifts: new Map([["sq1", 5]]), paycheckTipsCents: new Map([["sq1", 5000]]), cashTipsCents: new Map() },
      { shifts: new Map([["sq1", 5]]), paycheckTipsCents: new Map([["sq1", 5000]]), cashTipsCents: new Map() },
    ];
    const results = computePayrollEntries(employees, buckets, config);
    expect(results[0].bonus_cents).toBe(0);
    expect(results[0].paycheck_tips_cents).toBe(10000);
  });
});

describe("mergeAdjustments", () => {
  const computed = {
    employee_id: "e1",
    hours_worked: 10,
    paycheck_tips_cents: 500,
    cash_tips_cents: 100,
    reported_cash_tips_cents: 10,
    bonus_cents: 200,
    base_pay_cents: 1000,
    total_compensation_cents: 1800,
  };
  const noAdj = {
    adj_hours_worked: null, adj_paycheck_tips_cents: null, adj_cash_tips_cents: null,
    adj_reported_cash_tips_cents: null, adj_bonus_cents: null, admin_notes: null,
  };

  it("uses computed values when no adjustments", () => {
    const merged = mergeAdjustments(computed, noAdj, 10);
    expect(merged.effective_hours).toBe(10);
    expect(merged.effective_paycheck_tips_cents).toBe(500);
  });

  it("uses adjusted value when set", () => {
    const merged = mergeAdjustments(computed, { ...noAdj, adj_hours_worked: 12 }, 10);
    expect(merged.effective_hours).toBe(12);
  });

  it("recomputes total with effective values (total uses actual cash, not reported)", () => {
    const merged = mergeAdjustments(computed, { ...noAdj, adj_paycheck_tips_cents: 1000 }, 10);
    expect(merged.effective_total_compensation_cents).toBe(1000 + 1000 + 100 + 200);
  });

  it("reported cash: override wins, else re-derives from effective actual cash", () => {
    // no reported override → tracks effective actual (100) / divisor (10) = 10
    expect(mergeAdjustments(computed, noAdj, 10).effective_reported_cash_tips_cents).toBe(10);
    // override actual cash to 5000 → reported default re-derives = 500
    expect(mergeAdjustments(computed, { ...noAdj, adj_cash_tips_cents: 5000 }, 10)
      .effective_reported_cash_tips_cents).toBe(500);
    // explicit reported override wins regardless of actual
    expect(mergeAdjustments(computed, { ...noAdj, adj_reported_cash_tips_cents: 111 }, 10)
      .effective_reported_cash_tips_cents).toBe(111);
  });
});

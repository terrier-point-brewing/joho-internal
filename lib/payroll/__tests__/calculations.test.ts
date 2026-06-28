import { describe, it, expect } from "vitest";
import { computePayrollEntries, mergeAdjustments } from "../calculations";
import type { Employee, PayrollConfig } from "../types";

const config: PayrollConfig = {
  id: "c1",
  effective_from: "2026-01-01",
  base_rate_cents: 1000,       // $10/hr
  guaranteed_rate_cents: 1500, // $15/hr guaranteed
  cash_tips_rate: 0.01,
  tip_distribution_model: "proportional_hours",
  first_pay_period_start_date: "2026-01-05",
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

describe("computePayrollEntries", () => {
  it("distributes tips proportionally by hours", () => {
    const employees = [mkEmployee("e1", "sq1"), mkEmployee("e2", "sq2")];
    const shifts = new Map([["sq1", 30], ["sq2", 10]]); // 75% / 25%
    const results = computePayrollEntries(employees, shifts, 10000, 50000, config);
    const e1 = results.find((r) => r.employee_id === "e1")!;
    const e2 = results.find((r) => r.employee_id === "e2")!;
    expect(e1.paycheck_tips_cents).toBe(7500);
    expect(e2.paycheck_tips_cents).toBe(2500);
  });

  it("computes cash tips as rate × cash_take × hour_share", () => {
    const employees = [mkEmployee("e1", "sq1")];
    const shifts = new Map([["sq1", 10]]);
    const results = computePayrollEntries(employees, shifts, 0, 100000, config);
    // 1% of 100000 = 1000, all to e1
    expect(results[0].cash_tips_cents).toBe(1000);
  });

  it("computes bonus when tips don't meet guaranteed rate", () => {
    const employees = [mkEmployee("e1", "sq1")];
    const shifts = new Map([["sq1", 10]]);
    // base_pay = 10 * 1000 = 10000
    // guaranteed = 10 * 1500 = 15000
    // paycheck_tips = 0, cash_tips = 0
    // bonus = 15000 - 10000 - 0 - 0 = 5000
    const results = computePayrollEntries(employees, shifts, 0, 0, config);
    expect(results[0].bonus_cents).toBe(5000);
  });

  it("bonus is zero when tips exceed guaranteed rate", () => {
    const employees = [mkEmployee("e1", "sq1")];
    const shifts = new Map([["sq1", 10]]);
    // paycheck_tips = 10000, base_pay = 10000, guaranteed = 15000
    // 10000 + 10000 = 20000 > 15000, so bonus = 0
    const results = computePayrollEntries(employees, shifts, 10000, 0, config);
    expect(results[0].bonus_cents).toBe(0);
  });

  it("excludes employees without square_team_member_id", () => {
    const emp: Employee = { ...mkEmployee("e1", ""), square_team_member_id: null };
    const results = computePayrollEntries([emp], new Map(), 0, 0, config);
    expect(results).toHaveLength(0);
  });

  it("returns zero hours for employees not in shifts map", () => {
    const employees = [mkEmployee("e1", "sq1")];
    const results = computePayrollEntries(employees, new Map(), 0, 0, config);
    expect(results[0].hours_worked).toBe(0);
  });
});

describe("mergeAdjustments", () => {
  const computed = {
    employee_id: "e1",
    hours_worked: 10,
    paycheck_tips_cents: 500,
    cash_tips_cents: 100,
    bonus_cents: 200,
    base_pay_cents: 1000,
    total_compensation_cents: 1800,
  };

  it("uses computed values when no adjustments", () => {
    const entry = { adj_hours_worked: null, adj_paycheck_tips_cents: null, adj_cash_tips_cents: null, adj_bonus_cents: null, admin_notes: null };
    const merged = mergeAdjustments(computed, entry);
    expect(merged.effective_hours).toBe(10);
    expect(merged.effective_paycheck_tips_cents).toBe(500);
  });

  it("uses adjusted value when set", () => {
    const entry = { adj_hours_worked: 12, adj_paycheck_tips_cents: null, adj_cash_tips_cents: null, adj_bonus_cents: null, admin_notes: null };
    const merged = mergeAdjustments(computed, entry);
    expect(merged.effective_hours).toBe(12);
  });

  it("recomputes total with effective values", () => {
    const entry = { adj_hours_worked: null, adj_paycheck_tips_cents: 1000, adj_cash_tips_cents: null, adj_bonus_cents: null, admin_notes: null };
    const merged = mergeAdjustments(computed, entry);
    // base_pay + effective_paycheck + effective_cash + effective_bonus
    expect(merged.effective_total_compensation_cents).toBe(1000 + 1000 + 100 + 200);
  });
});

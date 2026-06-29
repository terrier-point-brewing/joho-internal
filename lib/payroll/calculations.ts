import type { Employee, PayrollConfig, PayrollEntryComputed, PayrollEntryMerged } from "./types";

/**
 * One guarantee-period bucket.
 * Tips are pre-attributed per employee (done in previewService) so this
 * function only needs to check whether base pay + tips meets the guarantee.
 */
export interface GuaranteeBucket {
  shifts: Map<string, number>;            // teamMemberId → hours in this period
  paycheckTipsCents: Map<string, number>; // teamMemberId → attributed paycheck tips
  cashTipsCents: Map<string, number>;     // teamMemberId → attributed cash tips
}

export function computePayrollEntries(
  employees: Employee[],
  buckets: GuaranteeBucket[],
  config: PayrollConfig
): PayrollEntryComputed[] {
  const tippedEmployees = employees.filter(
    (e) => e.employment_type === "hourly" && e.receives_tips && e.square_team_member_id
  );

  type Acc = { hours: number; paycheckTips: number; cashTips: number; basePay: number; bonus: number };
  const accum = new Map<string, Acc>();
  for (const emp of tippedEmployees) {
    accum.set(emp.id, { hours: 0, paycheckTips: 0, cashTips: 0, basePay: 0, bonus: 0 });
  }

  for (const bucket of buckets) {
    for (const emp of tippedEmployees) {
      const sqId = emp.square_team_member_id!;
      const hours = bucket.shifts.get(sqId) ?? 0;
      const paycheckTips = bucket.paycheckTipsCents.get(sqId) ?? 0;
      const cashTips = bucket.cashTipsCents.get(sqId) ?? 0;
      const basePay = Math.round(hours * config.base_rate_cents);
      const guaranteedMin = Math.round(hours * config.guaranteed_rate_cents);
      const bonus = Math.max(0, guaranteedMin - basePay - paycheckTips - cashTips);

      const a = accum.get(emp.id)!;
      a.hours += hours;
      a.paycheckTips += paycheckTips;
      a.cashTips += cashTips;
      a.basePay += basePay;
      a.bonus += bonus;
    }
  }

  return tippedEmployees.map((emp) => {
    const a = accum.get(emp.id)!;
    return {
      employee_id: emp.id,
      hours_worked: a.hours,
      paycheck_tips_cents: a.paycheckTips,
      cash_tips_cents: a.cashTips,
      bonus_cents: a.bonus,
      base_pay_cents: a.basePay,
      total_compensation_cents: a.basePay + a.paycheckTips + a.cashTips + a.bonus,
    };
  });
}

type AdjustmentSource = {
  adj_hours_worked: number | null;
  adj_paycheck_tips_cents: number | null;
  adj_cash_tips_cents: number | null;
  adj_bonus_cents: number | null;
  admin_notes: string | null;
};

export function mergeAdjustments(
  computed: PayrollEntryComputed,
  adjustments: AdjustmentSource
): PayrollEntryMerged {
  const effectiveHours = adjustments.adj_hours_worked ?? computed.hours_worked;
  const effectivePaycheckTips = adjustments.adj_paycheck_tips_cents ?? computed.paycheck_tips_cents;
  const effectiveCashTips = adjustments.adj_cash_tips_cents ?? computed.cash_tips_cents;
  const effectiveBonus = adjustments.adj_bonus_cents ?? computed.bonus_cents;
  const effectiveTotal = computed.base_pay_cents + effectivePaycheckTips + effectiveCashTips + effectiveBonus;

  return {
    ...computed,
    ...adjustments,
    effective_hours: effectiveHours,
    effective_paycheck_tips_cents: effectivePaycheckTips,
    effective_cash_tips_cents: effectiveCashTips,
    effective_bonus_cents: effectiveBonus,
    effective_total_compensation_cents: effectiveTotal,
  };
}

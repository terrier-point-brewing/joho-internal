import type { Employee, PayrollConfig, PayrollEntryComputed, PayrollEntryMerged } from "./types";

export function computePayrollEntries(
  employees: Employee[],
  shifts: Map<string, number>,
  totalPooledTipsCents: number,
  totalCashTakeCents: number,
  config: PayrollConfig
): PayrollEntryComputed[] {
  const tippedEmployees = employees.filter(
    (e) => e.employment_type === "hourly" && e.receives_tips && e.square_team_member_id
  );

  const totalHours = tippedEmployees.reduce(
    (sum, e) => sum + (shifts.get(e.square_team_member_id!) ?? 0),
    0
  );

  return tippedEmployees.map((employee) => {
    const hours = shifts.get(employee.square_team_member_id!) ?? 0;
    const hourShare = totalHours > 0 ? hours / totalHours : 0;

    const paycheckTipsCents = Math.round(hourShare * totalPooledTipsCents);
    const cashTipsCents = Math.round(hourShare * config.cash_tips_rate * totalCashTakeCents);
    const basePayCents = Math.round(hours * config.base_rate_cents);
    const guaranteedMinCents = Math.round(hours * config.guaranteed_rate_cents);
    const bonusCents = Math.max(0, guaranteedMinCents - basePayCents - paycheckTipsCents - cashTipsCents);
    const totalCompensationCents = basePayCents + paycheckTipsCents + cashTipsCents + bonusCents;

    return {
      employee_id: employee.id,
      hours_worked: hours,
      paycheck_tips_cents: paycheckTipsCents,
      cash_tips_cents: cashTipsCents,
      bonus_cents: bonusCents,
      base_pay_cents: basePayCents,
      total_compensation_cents: totalCompensationCents,
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

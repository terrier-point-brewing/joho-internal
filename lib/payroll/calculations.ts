import type { Employee, PayrollConfig, PayrollEntryComputed, PayrollEntryMerged } from "./types";

/**
 * One guarantee-period bucket.
 * Tips are pre-attributed per employee (done in previewService) so this
 * function only needs to check whether base pay + tips meets the guarantee.
 *
 * Built by re-aggregating buildDailyGrid's day-level maps at
 * guaranteed_min_frequency (see previewService.ts), so these maps carry
 * every team member present in the grid — tipped and non-tipped alike,
 * keyed by square_team_member_id — not just tipped employees.
 * computePayrollEntries below only looks up entries for tipped employees, so
 * the non-tipped entries are present but unread.
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

  type Acc = { hours: number; paycheckTips: number; cashTips: number; bonus: number };
  const accum = new Map<string, Acc>();
  for (const emp of tippedEmployees) {
    accum.set(emp.id, { hours: 0, paycheckTips: 0, cashTips: 0, bonus: 0 });
  }

  for (const bucket of buckets) {
    for (const emp of tippedEmployees) {
      const sqId = emp.square_team_member_id!;
      const hours = bucket.shifts.get(sqId) ?? 0;
      const paycheckTips = bucket.paycheckTipsCents.get(sqId) ?? 0;
      const cashTips = bucket.cashTipsCents.get(sqId) ?? 0;
      // Bucket-scoped base pay exists only to test the guarantee, which is
      // evaluated once per guarantee bucket and so must compare against that
      // bucket's own hours. It is deliberately NOT accumulated into reported
      // base pay — see the period-total rounding below.
      const bucketBasePay = Math.round(hours * config.base_rate_cents);
      const guaranteedMin = Math.round(hours * config.guaranteed_rate_cents);
      const bonus = Math.max(0, guaranteedMin - bucketBasePay - paycheckTips - cashTips);

      const a = accum.get(emp.id)!;
      a.hours += hours;
      a.paycheckTips += paycheckTips;
      a.cashTips += cashTips;
      a.bonus += bonus;
    }
  }

  const divisor = config.reported_cash_tips_divisor;
  return tippedEmployees.map((emp) => {
    const a = accum.get(emp.id)!;
    // Canonical base-pay rounding: once per employee, on the period's summed
    // hours. Gusto pays on period totals, and periodSummary.computePeriodBasis
    // reads the locked snapshot the same way. Rounding each guarantee bucket
    // and summing those drifts a cent or two per period against both.
    const basePay = Math.round(a.hours * config.base_rate_cents);
    return {
      employee_id: emp.id,
      hours_worked: a.hours,
      paycheck_tips_cents: a.paycheckTips,
      cash_tips_cents: a.cashTips,
      // Gusto-reported cash: actual declared cash reduced by the configured ratio.
      // Never feeds the bonus above — that uses actual a.cashTips.
      reported_cash_tips_cents: Math.round(a.cashTips / divisor),
      bonus_cents: a.bonus,
      base_pay_cents: basePay,
      total_compensation_cents: basePay + a.paycheckTips + a.cashTips + a.bonus,
    };
  });
}

type AdjustmentSource = {
  adj_hours_worked: number | null;
  adj_paycheck_tips_cents: number | null;
  adj_cash_tips_cents: number | null;
  adj_reported_cash_tips_cents: number | null;
  adj_bonus_cents: number | null;
  admin_notes: string | null;
};

export function mergeAdjustments(
  computed: PayrollEntryComputed,
  adjustments: AdjustmentSource,
  divisor: number,
  baseRateCents: number
): PayrollEntryMerged {
  const effectiveHours = adjustments.adj_hours_worked ?? computed.hours_worked;
  const effectivePaycheckTips = adjustments.adj_paycheck_tips_cents ?? computed.paycheck_tips_cents;
  const effectiveCashTips = adjustments.adj_cash_tips_cents ?? computed.cash_tips_cents;
  // Reported cash: explicit override wins; otherwise re-derive from the effective
  // actual cash so overriding actual cash also updates the reported default.
  const effectiveReportedCashTips =
    adjustments.adj_reported_cash_tips_cents ?? Math.round(effectiveCashTips / divisor);
  const effectiveBonus = adjustments.adj_bonus_cents ?? computed.bonus_cents;
  // Base pay is not independently adjustable — it is a function of hours, so an
  // adj_hours_worked override must move it. Derived exactly the way
  // periodSummary.computePeriodBasis derives it from the locked snapshot
  // (round(hours × baseRate)), so the preview and the periods table agree.
  const effectiveBasePay = Math.round(effectiveHours * baseRateCents);
  // Total comp uses actual cash (the real dollars); the reported figure is a
  // payroll-reporting construct surfaced separately in the UI/Gusto view.
  const effectiveTotal = effectiveBasePay + effectivePaycheckTips + effectiveCashTips + effectiveBonus;

  return {
    ...computed,
    ...adjustments,
    effective_hours: effectiveHours,
    effective_base_pay_cents: effectiveBasePay,
    effective_paycheck_tips_cents: effectivePaycheckTips,
    effective_cash_tips_cents: effectiveCashTips,
    effective_reported_cash_tips_cents: effectiveReportedCashTips,
    effective_bonus_cents: effectiveBonus,
    effective_total_compensation_cents: effectiveTotal,
  };
}

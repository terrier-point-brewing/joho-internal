import { fetchShiftHours } from "@/lib/square/labor";
import { fetchTipsAndCashTake } from "@/lib/square/payroll";
import { computePayrollEntries, mergeAdjustments } from "./calculations";
import type { Employee, PayPeriod, PayrollConfig, PayrollEntry, PayrollPreview } from "./types";

/**
 * Fetches live Square data and builds the full payroll preview.
 * Merges any stored admin adjustments from payroll_entries rows.
 * Called only by the /preview API route — never cached.
 */
export async function buildPayrollPreview(
  period: PayPeriod,
  allEmployees: Employee[],
  config: PayrollConfig,
  storedEntries: PayrollEntry[]
): Promise<PayrollPreview> {
  const hourlyTipped = allEmployees.filter(
    (e) => e.employment_type === "hourly" && e.receives_tips && e.active
  );
  const salariedEmployees = allEmployees.filter(
    (e) => e.employment_type !== "hourly" && e.active
  );

  const [shifts, { totalPooledTipsCents, totalCashTakeCents }] = await Promise.all([
    fetchShiftHours(period.start_date, period.end_date),
    fetchTipsAndCashTake(period.start_date, period.end_date),
  ]);

  const computed = computePayrollEntries(
    hourlyTipped,
    shifts,
    totalPooledTipsCents,
    totalCashTakeCents,
    config
  );

  const entryMap = new Map(storedEntries.map((e) => [e.employee_id, e]));

  const entries = computed.map((c) => {
    const stored = entryMap.get(c.employee_id);
    return mergeAdjustments(c, {
      adj_hours_worked: stored?.adj_hours_worked ?? null,
      adj_paycheck_tips_cents: stored?.adj_paycheck_tips_cents ?? null,
      adj_cash_tips_cents: stored?.adj_cash_tips_cents ?? null,
      adj_bonus_cents: stored?.adj_bonus_cents ?? null,
      admin_notes: stored?.admin_notes ?? null,
    });
  });

  // Only return employees that have a corresponding computed entry, so the UI
  // can resolve each entry to its employee by id.
  const entryIds = new Set(entries.map((e) => e.employee_id));
  const employees = hourlyTipped.filter((e) => entryIds.has(e.id));

  return {
    period,
    config,
    entries,
    employees,
    salaried_employees: salariedEmployees,
    total_pooled_tips_cents: totalPooledTipsCents,
    total_cash_take_cents: totalCashTakeCents,
  };
}

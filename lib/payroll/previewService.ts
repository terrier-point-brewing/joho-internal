import { computePayrollEntries, mergeAdjustments, GuaranteeBucket } from "./calculations";
import type {
  Employee, PayPeriod, PayrollConfig, PayrollEntry, PayrollPreview,
  TipBucketSummary,
} from "./types";
import { buildDailyGrid, dayGroups } from "./dailyGrid";
import type { DayOverride } from "./dailyGrid";

/**
 * Two-step attribution:
 *  1. Pool tips at tip_pool_frequency → attribute to each tipped employee per day
 *  2. Re-aggregate daily attributed tips into guarantee-frequency buckets
 *
 * This allows tip pooling and guaranteed-min checks to operate at independent granularities.
 */
async function buildGuaranteeBuckets(
  period: PayPeriod,
  employees: Employee[],
  config: PayrollConfig,
  overrides: DayOverride[],
): Promise<{ buckets: GuaranteeBucket[]; tip_buckets: TipBucketSummary[]; totalPooledTipsCents: number }> {
  const grid = await buildDailyGrid(
    period, employees, config.tip_pool_frequency ?? "biweekly", overrides
  );

  // Guarantee bucketing is independent of tip-pool bucketing: re-aggregate the
  // day-level maps at guaranteed_min_frequency. Keys stay square_team_member_id,
  // which is what GuaranteeBucket and computePayrollEntries already expect.
  const buckets: GuaranteeBucket[] = dayGroups(
    grid.days, config.guaranteed_min_frequency ?? "biweekly"
  ).map(group => {
    const shifts = new Map<string, number>();
    const paycheckTipsCents = new Map<string, number>();
    const cashTipsCents = new Map<string, number>();
    for (const day of group) {
      for (const [sqId, h] of grid.hoursByDate.get(day) ?? []) {
        shifts.set(sqId, (shifts.get(sqId) ?? 0) + h);
      }
      for (const [sqId, t] of grid.cardTipsByDate.get(day) ?? []) {
        paycheckTipsCents.set(sqId, (paycheckTipsCents.get(sqId) ?? 0) + t);
      }
      for (const [sqId, c] of grid.cashByDate.get(day) ?? []) {
        cashTipsCents.set(sqId, (cashTipsCents.get(sqId) ?? 0) + c);
      }
    }
    return { shifts, paycheckTipsCents, cashTipsCents };
  });

  return {
    buckets,
    tip_buckets: grid.buckets.map(b => ({ label: b.label, tipsPooledCents: b.pool_cents })),
    totalPooledTipsCents: grid.totalPooledTipsCents,
  };
}

export async function buildPayrollPreview(
  period: PayPeriod,
  allEmployees: Employee[],
  config: PayrollConfig,
  storedEntries: PayrollEntry[],
  overrides: DayOverride[] = []
): Promise<PayrollPreview> {
  const hourlyTipped = allEmployees.filter(
    (e) => e.employment_type === "hourly" && e.receives_tips && e.active
  );
  const salariedEmployees = allEmployees.filter(
    (e) => e.employment_type !== "hourly" && e.active
  );

  const { buckets, tip_buckets, totalPooledTipsCents } =
    await buildGuaranteeBuckets(period, allEmployees, config, overrides);

  const computed = computePayrollEntries(hourlyTipped, buckets, config);

  const entryMap = new Map(storedEntries.map((e) => [e.employee_id, e]));
  // Spec §3: employees with a stored day override, so the Summary row can flag
  // a period-level adj_* that masks it (period-level always wins on read).
  const employeesWithDayOverrides = new Set(overrides.map((o) => o.employee_id));
  const entries = computed.map((c) => {
    const stored = entryMap.get(c.employee_id);
    const merged = mergeAdjustments(c, {
      adj_hours_worked: stored?.adj_hours_worked ?? null,
      adj_paycheck_tips_cents: stored?.adj_paycheck_tips_cents ?? null,
      adj_cash_tips_cents: stored?.adj_cash_tips_cents ?? null,
      adj_reported_cash_tips_cents: stored?.adj_reported_cash_tips_cents ?? null,
      adj_bonus_cents: stored?.adj_bonus_cents ?? null,
      admin_notes: stored?.admin_notes ?? null,
    }, config.reported_cash_tips_divisor);
    return { ...merged, has_day_overrides: employeesWithDayOverrides.has(c.employee_id) };
  });

  const entryIds = new Set(entries.map((e) => e.employee_id));
  const employees = hourlyTipped.filter((e) => entryIds.has(e.id));

  return {
    period,
    config,
    entries,
    employees,
    salaried_employees: salariedEmployees,
    total_pooled_tips_cents: totalPooledTipsCents,
    tip_buckets,
  };
}

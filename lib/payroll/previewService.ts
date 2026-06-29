import { fetchShiftsByDay } from "@/lib/square/labor";
import { fetchTipsAndCashTakeByDay } from "@/lib/square/payroll";
import { computePayrollEntries, mergeAdjustments, GuaranteeBucket } from "./calculations";
import type {
  Employee, PayPeriod, PayrollConfig, PayrollEntry, PayrollPreview,
  TipBucketSummary, TipPoolFrequency,
} from "./types";

function getDays(startDate: string, endDate: string): string[] {
  const days: string[] = [];
  const cursor = new Date(startDate + "T12:00:00Z");
  const end = new Date(endDate + "T12:00:00Z");
  while (cursor <= end) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function dayGroups(days: string[], frequency: TipPoolFrequency): string[][] {
  if (frequency === "biweekly") return [days];
  if (frequency === "daily") return days.map(d => [d]);
  const groups: string[][] = [];
  for (let i = 0; i < days.length; i += 7) groups.push(days.slice(i, i + 7));
  return groups;
}

function fmtDate(d: string): string {
  const [, m, day] = d.split("-");
  return `${parseInt(m)}/${parseInt(day)}`;
}

function bucketLabels(frequency: TipPoolFrequency, startDate: string, endDate: string): string[] {
  const days = getDays(startDate, endDate);
  if (frequency === "biweekly") return [`${fmtDate(startDate)} – ${fmtDate(endDate)}`];
  if (frequency === "daily") return days.map(fmtDate);
  const labels: string[] = [];
  for (let i = 0; i < days.length; i += 7) {
    const w = days.slice(i, i + 7);
    labels.push(`${fmtDate(w[0])} – ${fmtDate(w[w.length - 1])}`);
  }
  return labels;
}

/**
 * Two-step attribution:
 *  1. Pool tips at tip_pool_frequency → attribute to each tipped employee per day
 *  2. Re-aggregate daily attributed tips into guarantee-frequency buckets
 *
 * This allows tip pooling and guaranteed-min checks to operate at independent granularities.
 */
async function buildGuaranteeBuckets(
  period: PayPeriod,
  tippedTeamIds: Set<string>,
  config: PayrollConfig,
): Promise<{
  buckets: GuaranteeBucket[];
  tip_buckets: TipBucketSummary[];
  totalPooledTipsCents: number;
  totalCashTakeCents: number;
}> {
  const days = getDays(period.start_date, period.end_date);
  const tipFrequency: TipPoolFrequency = config.tip_pool_frequency ?? "biweekly";
  const guaranteeFrequency: TipPoolFrequency = config.guaranteed_min_frequency ?? "biweekly";

  const [dailyShifts, dailyTipsArr] = await Promise.all([
    fetchShiftsByDay(period.start_date, period.end_date),
    fetchTipsAndCashTakeByDay(period.start_date, period.end_date),
  ]);

  // Index shifts: date → teamMemberId → hours
  const shiftsByDate = new Map<string, Map<string, number>>();
  for (const s of dailyShifts) {
    if (!shiftsByDate.has(s.date)) shiftsByDate.set(s.date, new Map());
    const m = shiftsByDate.get(s.date)!;
    m.set(s.team_member_id, (m.get(s.team_member_id) ?? 0) + s.hours);
  }

  // Index tips: date → amounts
  const tipsMap = new Map(dailyTipsArr.map(t => [t.date, t]));

  // ── Step 1: attribute tips to individual days ──────────────────────────────
  const tipGroups = dayGroups(days, tipFrequency);
  const tipLabels = bucketLabels(tipFrequency, period.start_date, period.end_date);

  const dailyPaycheckTips = new Map<string, Map<string, number>>(); // date → sqId → cents
  const dailyCashTips = new Map<string, Map<string, number>>();

  const tip_buckets: TipBucketSummary[] = [];
  let totalPooledTipsCents = 0;
  let totalCashTakeCents = 0;

  for (let gi = 0; gi < tipGroups.length; gi++) {
    const group = tipGroups[gi];
    let groupTips = 0;
    let groupCash = 0;
    for (const day of group) {
      groupTips += tipsMap.get(day)?.tipsPooledCents ?? 0;
      groupCash += tipsMap.get(day)?.cashTakeCents ?? 0;
    }
    totalPooledTipsCents += groupTips;
    totalCashTakeCents += groupCash;
    tip_buckets.push({ label: tipLabels[gi] ?? `Bucket ${gi + 1}`, tipsPooledCents: groupTips, cashTakeCents: groupCash });

    // Total tipped-employee hours in this tip pool group (the denominator)
    let totalGroupHours = 0;
    for (const day of group) {
      for (const [id, h] of shiftsByDate.get(day) ?? []) {
        if (tippedTeamIds.has(id)) totalGroupHours += h;
      }
    }

    // Attribute group tips to each employee-day proportional to hours
    for (const day of group) {
      if (!dailyPaycheckTips.has(day)) dailyPaycheckTips.set(day, new Map());
      if (!dailyCashTips.has(day)) dailyCashTips.set(day, new Map());
      const ptMap = dailyPaycheckTips.get(day)!;
      const ctMap = dailyCashTips.get(day)!;
      for (const [id, dayHrs] of shiftsByDate.get(day) ?? []) {
        if (!tippedTeamIds.has(id) || dayHrs <= 0) continue;
        const share = totalGroupHours > 0 ? dayHrs / totalGroupHours : 0;
        ptMap.set(id, Math.round(share * groupTips));
        ctMap.set(id, Math.round(share * config.cash_tips_rate * groupCash));
      }
    }
  }

  // ── Step 2: aggregate daily attributed tips into guarantee buckets ─────────
  const guaranteeGroups = dayGroups(days, guaranteeFrequency);
  const buckets: GuaranteeBucket[] = guaranteeGroups.map(group => {
    const shifts = new Map<string, number>();
    const paycheckTipsCents = new Map<string, number>();
    const cashTipsCents = new Map<string, number>();
    for (const day of group) {
      for (const [id, h] of shiftsByDate.get(day) ?? []) {
        if (!tippedTeamIds.has(id)) continue;
        shifts.set(id, (shifts.get(id) ?? 0) + h);
      }
      for (const [id, pt] of dailyPaycheckTips.get(day) ?? []) {
        paycheckTipsCents.set(id, (paycheckTipsCents.get(id) ?? 0) + pt);
      }
      for (const [id, ct] of dailyCashTips.get(day) ?? []) {
        cashTipsCents.set(id, (cashTipsCents.get(id) ?? 0) + ct);
      }
    }
    return { shifts, paycheckTipsCents, cashTipsCents };
  });

  return { buckets, tip_buckets, totalPooledTipsCents, totalCashTakeCents };
}

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

  const tippedTeamIds = new Set(
    hourlyTipped.filter(e => e.square_team_member_id).map(e => e.square_team_member_id!)
  );

  const { buckets, tip_buckets, totalPooledTipsCents, totalCashTakeCents } =
    await buildGuaranteeBuckets(period, tippedTeamIds, config);

  const computed = computePayrollEntries(hourlyTipped, buckets, config);

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
    tip_buckets,
  };
}

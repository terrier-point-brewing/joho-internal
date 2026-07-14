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
}> {
  const days = getDays(period.start_date, period.end_date);
  const tipFrequency: TipPoolFrequency = config.tip_pool_frequency ?? "biweekly";
  const guaranteeFrequency: TipPoolFrequency = config.guaranteed_min_frequency ?? "biweekly";

  const [dailyShifts, dailyTipsArr] = await Promise.all([
    fetchShiftsByDay(period.start_date, period.end_date),
    fetchTipsAndCashTakeByDay(period.start_date, period.end_date),
  ]);

  // Index shifts: date → teamMemberId → hours, and date → teamMemberId → declared cash
  const shiftsByDate = new Map<string, Map<string, number>>();
  const cashByDate = new Map<string, Map<string, number>>();
  for (const s of dailyShifts) {
    if (!shiftsByDate.has(s.date)) shiftsByDate.set(s.date, new Map());
    shiftsByDate.get(s.date)!.set(s.team_member_id, (shiftsByDate.get(s.date)!.get(s.team_member_id) ?? 0) + s.hours);
    if (!cashByDate.has(s.date)) cashByDate.set(s.date, new Map());
    cashByDate.get(s.date)!.set(s.team_member_id, (cashByDate.get(s.date)!.get(s.team_member_id) ?? 0) + s.cash_tips_cents);
  }

  // Index pooled (card) tips: date → cents
  const tipsMap = new Map(dailyTipsArr.map(t => [t.date, t]));

  // ── Step 1: attribute pooled CARD tips to individual days (cash is declared, not pooled) ──
  const tipGroups = dayGroups(days, tipFrequency);
  const tipLabels = bucketLabels(tipFrequency, period.start_date, period.end_date);

  const dailyPaycheckTips = new Map<string, Map<string, number>>(); // date → sqId → cents

  const tip_buckets: TipBucketSummary[] = [];
  let totalPooledTipsCents = 0;

  for (let gi = 0; gi < tipGroups.length; gi++) {
    const group = tipGroups[gi];
    let groupTips = 0;
    for (const day of group) {
      groupTips += tipsMap.get(day)?.tipsPooledCents ?? 0;
    }
    totalPooledTipsCents += groupTips;
    tip_buckets.push({ label: tipLabels[gi] ?? `Bucket ${gi + 1}`, tipsPooledCents: groupTips });

    // Total tipped-employee hours in this tip pool group (the denominator)
    let totalGroupHours = 0;
    for (const day of group) {
      for (const [id, h] of shiftsByDate.get(day) ?? []) {
        if (tippedTeamIds.has(id)) totalGroupHours += h;
      }
    }

    // Attribute group card tips to each employee-day proportional to hours
    for (const day of group) {
      if (!dailyPaycheckTips.has(day)) dailyPaycheckTips.set(day, new Map());
      const ptMap = dailyPaycheckTips.get(day)!;
      for (const [id, dayHrs] of shiftsByDate.get(day) ?? []) {
        if (!tippedTeamIds.has(id) || dayHrs <= 0) continue;
        const share = totalGroupHours > 0 ? dayHrs / totalGroupHours : 0;
        ptMap.set(id, Math.round(share * groupTips));
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
      // Actual declared cash, straight from the shift record (no pool, no rate).
      for (const [id, ct] of cashByDate.get(day) ?? []) {
        if (!tippedTeamIds.has(id)) continue;
        cashTipsCents.set(id, (cashTipsCents.get(id) ?? 0) + ct);
      }
    }
    return { shifts, paycheckTipsCents, cashTipsCents };
  });

  return { buckets, tip_buckets, totalPooledTipsCents };
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

  const { buckets, tip_buckets, totalPooledTipsCents } =
    await buildGuaranteeBuckets(period, tippedTeamIds, config);

  const computed = computePayrollEntries(hourlyTipped, buckets, config);

  const entryMap = new Map(storedEntries.map((e) => [e.employee_id, e]));
  const entries = computed.map((c) => {
    const stored = entryMap.get(c.employee_id);
    return mergeAdjustments(c, {
      adj_hours_worked: stored?.adj_hours_worked ?? null,
      adj_paycheck_tips_cents: stored?.adj_paycheck_tips_cents ?? null,
      adj_cash_tips_cents: stored?.adj_cash_tips_cents ?? null,
      adj_reported_cash_tips_cents: stored?.adj_reported_cash_tips_cents ?? null,
      adj_bonus_cents: stored?.adj_bonus_cents ?? null,
      admin_notes: stored?.admin_notes ?? null,
    }, config.reported_cash_tips_divisor);
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

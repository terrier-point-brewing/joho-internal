import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";
import { fetchShiftsByDay } from "@/lib/square/labor";
import { fetchTipsAndCashTakeByDay } from "@/lib/square/payroll";
import type { TipPoolFrequency } from "@/lib/payroll/types";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try { await requireRole([]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { id } = await params;

  const [
    { data: period, error: pErr },
    { data: employees },
    { data: config },
  ] = await Promise.all([
    supabase.from("pay_periods").select("start_date, end_date").eq("id", id).single(),
    supabase.from("employees").select("id, first_name, last_name, square_team_member_id, receives_tips").not("square_team_member_id", "is", null),
    supabase.from("payroll_config").select("tip_pool_frequency").order("effective_from", { ascending: false }).limit(1).single(),
  ]);

  if (pErr || !period) return apiError("Period not found", 404);

  const frequency = ((config as { tip_pool_frequency?: string } | null)?.tip_pool_frequency ?? "biweekly") as TipPoolFrequency;

  const empByTeamId = new Map(
    (employees ?? []).map(e => [e.square_team_member_id as string, e])
  );

  // Team member IDs that participate in the tip pool
  const tippedTeamIds = new Set(
    (employees ?? []).filter(e => e.receives_tips).map(e => e.square_team_member_id as string)
  );

  let rawShifts;
  let dailyTips;
  try {
    [rawShifts, dailyTips] = await Promise.all([
      fetchShiftsByDay(period.start_date, period.end_date),
      fetchTipsAndCashTakeByDay(period.start_date, period.end_date),
    ]);
  } catch (err) {
    return apiError(err instanceof Error ? err.message : String(err));
  }

  // Generate every calendar day in the period
  const days: string[] = [];
  const cursor = new Date(period.start_date + "T12:00:00Z");
  const endDay = new Date(period.end_date + "T12:00:00Z");
  while (cursor <= endDay) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  // Index shifts by date → teamMemberId → hours
  const shiftsByDate = new Map<string, Map<string, number>>();
  for (const shift of rawShifts) {
    if (!shiftsByDate.has(shift.date)) shiftsByDate.set(shift.date, new Map());
    const m = shiftsByDate.get(shift.date)!;
    m.set(shift.team_member_id, (m.get(shift.team_member_id) ?? 0) + shift.hours);
  }

  // Index pooled tips by date
  const tipsMap = new Map(dailyTips.map(t => [t.date, t.tipsPooledCents]));

  // Build pool buckets with day membership — mirrors previewService.buildBuckets
  type BucketWithDays = { days: string[]; shifts: Map<string, number>; tipsPooledCents: number };

  function buildBucketsWithDays(): BucketWithDays[] {
    const makeBucket = (bDays: string[]): BucketWithDays => {
      const shifts = new Map<string, number>();
      let tips = 0;
      for (const day of bDays) {
        for (const [id, h] of shiftsByDate.get(day) ?? []) {
          shifts.set(id, (shifts.get(id) ?? 0) + h);
        }
        tips += tipsMap.get(day) ?? 0;
      }
      return { days: bDays, shifts, tipsPooledCents: tips };
    };

    if (frequency === "daily") return days.map(d => makeBucket([d]));
    if (frequency === "biweekly") return [makeBucket(days)];
    // weekly
    const buckets: BucketWithDays[] = [];
    for (let i = 0; i < days.length; i += 7) buckets.push(makeBucket(days.slice(i, i + 7)));
    return buckets;
  }

  const buckets = buildBucketsWithDays();

  // For each bucket, compute each tipped employee's tip share,
  // then attribute it back to individual days proportional to daily hours within the bucket.
  const dailyTipsCents = new Map<string, Map<string, number>>();

  for (const bucket of buckets) {
    const totalBucketHours = [...bucket.shifts.entries()]
      .filter(([id]) => tippedTeamIds.has(id))
      .reduce((s, [, h]) => s + h, 0);

    for (const [teamMemberId, bucketHrs] of bucket.shifts) {
      if (!tippedTeamIds.has(teamMemberId)) continue;
      const hourShare = totalBucketHours > 0 ? bucketHrs / totalBucketHours : 0;
      const empBucketTips = Math.round(hourShare * bucket.tipsPooledCents);

      for (const day of bucket.days) {
        const dayHrs = shiftsByDate.get(day)?.get(teamMemberId) ?? 0;
        if (dayHrs <= 0) continue;
        const dayFraction = bucketHrs > 0 ? dayHrs / bucketHrs : 0;
        const dayTips = Math.round(dayFraction * empBucketTips);
        if (!dailyTipsCents.has(teamMemberId)) dailyTipsCents.set(teamMemberId, new Map());
        const m = dailyTipsCents.get(teamMemberId)!;
        m.set(day, (m.get(day) ?? 0) + dayTips);
      }
    }
  }

  // Build row map
  const rowMap = new Map<string, {
    employee_id: string;
    name: string;
    daily_hours: Record<string, number>;
    total_hours: number;
    daily_tips_cents: Record<string, number> | null;
    total_tips_cents: number | null;
  }>();

  for (const shift of rawShifts) {
    const emp = empByTeamId.get(shift.team_member_id);
    if (!rowMap.has(shift.team_member_id)) {
      rowMap.set(shift.team_member_id, {
        employee_id: emp?.id ?? shift.team_member_id,
        name: emp ? `${emp.first_name} ${emp.last_name}` : shift.team_member_id,
        daily_hours: {},
        total_hours: 0,
        daily_tips_cents: tippedTeamIds.has(shift.team_member_id) ? {} : null,
        total_tips_cents: tippedTeamIds.has(shift.team_member_id) ? 0 : null,
      });
    }
    const row = rowMap.get(shift.team_member_id)!;
    row.daily_hours[shift.date] = (row.daily_hours[shift.date] ?? 0) + shift.hours;
    row.total_hours += shift.hours;
  }

  // Populate tip totals from pre-computed dailyTipsCents
  for (const [teamMemberId, dayMap] of dailyTipsCents) {
    const row = rowMap.get(teamMemberId);
    if (!row || row.daily_tips_cents === null) continue;
    let total = 0;
    for (const [day, cents] of dayMap) {
      row.daily_tips_cents[day] = cents;
      total += cents;
    }
    row.total_tips_cents = total;
  }

  return NextResponse.json({
    days,
    tip_pool_frequency: frequency,
    rows: Array.from(rowMap.values()).sort((a, b) => b.total_hours - a.total_hours),
  });
}

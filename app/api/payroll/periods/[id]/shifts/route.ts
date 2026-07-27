import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";
import { buildDailyGrid, type DayOverride } from "@/lib/payroll/dailyGrid";
import type { Employee, PayPeriod, TipPoolFrequency } from "@/lib/payroll/types";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // payrollRead, not payrollManage: the Taproom payroll page gates at
  // payrollRead, so an admin-only gate here 403s managers on a visible tab.
  try { await requirePermission(CAP.payrollRead); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { id } = await params;

  const [{ data: period, error: pErr }, { data: employees }, { data: config }] = await Promise.all([
    supabase.from("pay_periods").select("start_date, end_date").eq("id", id).single(),
    supabase.from("employees")
      .select("id, first_name, last_name, square_team_member_id, receives_tips, employment_type, active")
      .not("square_team_member_id", "is", null),
    supabase.from("payroll_config").select("tip_pool_frequency")
      .order("effective_from", { ascending: false }).limit(1).single(),
  ]);

  if (pErr || !period) return apiError("Period not found", 404);

  const { data: overrideRows } = await supabase
    .from("payroll_shift_overrides")
    .select("employee_id, work_date, adj_hours, adj_paycheck_tips_cents, adj_cash_tips_cents, note")
    .eq("pay_period_id", id);

  const overrides = (overrideRows ?? []) as DayOverride[];
  const emps = (employees ?? []) as Employee[];
  const frequency = ((config as { tip_pool_frequency?: string } | null)?.tip_pool_frequency
    ?? "biweekly") as TipPoolFrequency;

  let grid, baseline;
  try {
    // Two passes over already-fetched data: `baseline` (no overrides) gives the
    // struck-through original. Card tips rebalance, so a cell's "original" is
    // only meaningful as what it would have been with no pins in the bucket.
    [grid, baseline] = await Promise.all([
      buildDailyGrid(period as PayPeriod, emps, frequency, overrides),
      buildDailyGrid(period as PayPeriod, emps, frequency, []),
    ]);
  } catch (err) {
    return apiError(err instanceof Error ? err.message : String(err));
  }

  const empBySq = new Map(emps.map(e => [e.square_team_member_id!, e]));
  const ovByEmpDate = new Map(overrides.map(o => [`${o.employee_id}|${o.work_date}`, o]));

  // Every square id that has any hours, cash, or card tips in either pass.
  const sqIds = new Set<string>();
  for (const m of [grid.hoursByDate, grid.cashByDate, grid.cardTipsByDate]) {
    for (const inner of m.values()) for (const sq of inner.keys()) sqIds.add(sq);
  }
  // Override mode must be able to fix someone with no shifts at all.
  for (const e of emps) {
    if (e.active && e.employment_type === "hourly" && e.receives_tips) sqIds.add(e.square_team_member_id!);
  }

  const pick = (m: Map<string, Map<string, number>>, sq: string) => {
    const out: Record<string, number> = {};
    for (const day of grid.days) {
      const v = m.get(day)?.get(sq);
      if (v != null) out[day] = v;
    }
    return out;
  };
  const total = (r: Record<string, number>) => Object.values(r).reduce((s, v) => s + v, 0);

  const rows = [...sqIds].map(sq => {
    const emp = empBySq.get(sq);
    const isTipped = !!emp?.receives_tips;
    const daily_hours = pick(grid.hoursByDate, sq);
    const overridesForRow: Record<string, {
      adj_hours: number | null;
      adj_paycheck_tips_cents: number | null;
      adj_cash_tips_cents: number | null;
      note: string | null;
    }> = {};
    if (emp) {
      for (const day of grid.days) {
        const o = ovByEmpDate.get(`${emp.id}|${day}`);
        if (o) overridesForRow[day] = {
          adj_hours: o.adj_hours,
          adj_paycheck_tips_cents: o.adj_paycheck_tips_cents,
          adj_cash_tips_cents: o.adj_cash_tips_cents,
          note: o.note,
        };
      }
    }
    return {
      employee_id: emp?.id ?? sq,
      name: emp ? `${emp.first_name} ${emp.last_name}` : sq,
      overridable: !!emp,
      daily_hours,
      total_hours: total(daily_hours),
      daily_tips_cents: isTipped ? pick(grid.cardTipsByDate, sq) : null,
      total_tips_cents: isTipped ? total(pick(grid.cardTipsByDate, sq)) : null,
      daily_cash_tips_cents: isTipped ? pick(grid.cashByDate, sq) : null,
      total_cash_tips_cents: isTipped ? total(pick(grid.cashByDate, sq)) : null,
      overrides: overridesForRow,
      source_hours: pick(baseline.hoursByDate, sq),
      source_tips_cents: isTipped ? pick(baseline.cardTipsByDate, sq) : null,
      source_cash_tips_cents: isTipped ? pick(baseline.cashByDate, sq) : null,
    };
  }).sort((a, b) => b.total_hours - a.total_hours);

  return NextResponse.json({
    days: grid.days,
    tip_pool_frequency: frequency,
    tip_buckets: grid.buckets,
    pool_variance: grid.buckets
      .filter(b => b.attributed_cents !== b.pool_cents)
      .map(b => ({ label: b.label, pool_cents: b.pool_cents, attributed_cents: b.attributed_cents })),
    rows,
  });
}

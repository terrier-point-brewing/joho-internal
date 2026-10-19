import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";
import { fetchDayGridInputs, computeDailyGrid, type DayOverride } from "@/lib/payroll/dailyGrid";
import type { Employee, PayPeriod, TipPoolFrequency } from "@/lib/payroll/types";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Exclude one day's card-tip pool from payroll, on the record.
 *
 * The lock gate refuses a pool that never landed on an employee. When nobody
 * tip-eligible worked (a salaried worker rang the sale), the owner's rule is
 * that the tip is paid to no one — so the answer is not a day override that
 * invents a recipient, it is this: an admin states the amount and the reason,
 * the gate treats the day as 0 to attribute, and the money stays in GL 2310
 * Undistributed Tips for finance to reclass.
 */
async function loadOpenPeriod(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>, id: string, date: string,
): Promise<{ period: PayPeriod; error?: undefined } | { period?: undefined; error: Response }> {
  const { data: period, error } = await supabase
    .from("pay_periods").select("id, start_date, end_date, status").eq("id", id).single();
  if (error || !period) return { error: apiError("Period not found", 404) };
  if (period.status !== "open") {
    return { error: NextResponse.json({ error: "Period is locked" }, { status: 409 }) };
  }
  if (!DATE_RE.test(date)) return { error: apiError("date must be YYYY-MM-DD", 400) };
  if (date < period.start_date || date > period.end_date) {
    return { error: apiError(`${date} is outside this pay period`, 400) };
  }
  return { period: period as PayPeriod };
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; date: string }> }
) {
  let session;
  try { session = await requirePermission(CAP.payrollDayOverride); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { id, date } = await params;
  const loaded = await loadOpenPeriod(supabase, id, date);
  if (loaded.error) return loaded.error;
  const period = loaded.period;

  const body = await req.json().catch(() => null) as { reason?: unknown } | null;
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (!reason) return apiError("A reason is required to exclude a day's card tips", 400);

  const [{ data: employees }, { data: config }, { data: overrideRows }] = await Promise.all([
    supabase.from("employees")
      .select("id, first_name, last_name, square_team_member_id, receives_tips, employment_type, active")
      .not("square_team_member_id", "is", null),
    supabase.from("payroll_config").select("tip_pool_frequency")
      .order("effective_from", { ascending: false }).limit(1).single(),
    supabase.from("payroll_shift_overrides")
      .select("employee_id, work_date, adj_hours, adj_paycheck_tips_cents, adj_cash_tips_cents, note")
      .eq("pay_period_id", id).eq("work_date", date),
  ]);
  const frequency = ((config as { tip_pool_frequency?: string } | null)?.tip_pool_frequency
    ?? "biweekly") as TipPoolFrequency;
  const overrides = (overrideRows ?? []) as DayOverride[];
  const emps = (employees ?? []) as Employee[];

  // A pin on this day would pay out the very pool being declared unpayable.
  if (overrides.some(o => o.adj_paycheck_tips_cents != null)) {
    return NextResponse.json(
      { error: `${date} has a pinned card-tip override; clear it before excluding the day.` },
      { status: 422 },
    );
  }

  let dayPoolCents = 0;
  let tippedHours = 0;
  try {
    const inputs = await fetchDayGridInputs(period);
    const grid = computeDailyGrid(inputs, period, emps, frequency, overrides);
    dayPoolCents = inputs.dailyTips.find(t => t.date === date)?.tipsPooledCents ?? 0;
    const tippedSq = new Set(
      emps.filter(e => e.receives_tips && e.active && e.employment_type === "hourly")
        .map(e => e.square_team_member_id!),
    );
    for (const [sqId, h] of grid.hoursByDate.get(date) ?? []) if (tippedSq.has(sqId)) tippedHours += h;
  } catch (err) {
    return apiError(err instanceof Error ? err.message : String(err));
  }

  // Only a day nobody tip-eligible worked qualifies. If someone eligible had
  // hours, the pool has a lawful recipient and the gate must keep saying so.
  if (tippedHours > 0) {
    return NextResponse.json(
      { error: `${date} has ${tippedHours.toFixed(2)} tip-eligible hours; its card tips belong to those employees.` },
      { status: 422 },
    );
  }
  if (dayPoolCents <= 0) {
    return NextResponse.json({ error: `${date} has no card tips to exclude.` }, { status: 422 });
  }

  const { data: row, error: uErr } = await supabase
    .from("payroll_tip_day_exclusions")
    .upsert({
      pay_period_id: id,
      work_date: date,
      amount_cents: dayPoolCents,
      reason,
      created_by: session.user.id,
      created_at: new Date().toISOString(),
    }, { onConflict: "pay_period_id,work_date" })
    .select("work_date, amount_cents, reason, created_at")
    .single();
  if (uErr) return apiError(uErr.message);

  return NextResponse.json(row);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; date: string }> }
) {
  try { await requirePermission(CAP.payrollDayOverride); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { id, date } = await params;
  const loaded = await loadOpenPeriod(supabase, id, date);
  if (loaded.error) return loaded.error;

  const { error } = await supabase
    .from("payroll_tip_day_exclusions").delete()
    .eq("pay_period_id", id).eq("work_date", date);
  if (error) return apiError(error.message);

  return NextResponse.json({ ok: true });
}

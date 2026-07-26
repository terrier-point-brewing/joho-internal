import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";
import { computeNextPeriodDates, addDays } from "@/lib/payroll/periodUtils";
import type { PayPeriodFrequency } from "@/lib/payroll/periodUtils";

export const dynamic = "force-dynamic";

export async function GET() {
  try { await requirePermission(CAP.payrollManage); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("payroll_config")
    .select("*")
    .order("effective_from", { ascending: false })
    .limit(1)
    .single();

  if (error) return apiError(error.message, 404);
  return NextResponse.json(data);
}

export async function PATCH(req: NextRequest) {
  try { await requirePermission(CAP.payrollManage); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const body = await req.json();
  const {
    effective_from,
    base_rate_cents,
    guaranteed_rate_cents,
    reported_cash_tips_divisor,
    tip_distribution_model,
    pay_period_frequency,
    tip_pool_frequency,
    guaranteed_min_frequency,
    due_date_days_after_end,
  } = body;

  if (!effective_from || !base_rate_cents || !guaranteed_rate_cents) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  if (
    reported_cash_tips_divisor != null &&
    (!Number.isInteger(reported_cash_tips_divisor) || reported_cash_tips_divisor < 1)
  ) {
    return NextResponse.json({ error: "Invalid reported_cash_tips_divisor" }, { status: 400 });
  }

  if (pay_period_frequency && !["weekly", "biweekly"].includes(pay_period_frequency)) {
    return NextResponse.json({ error: "Invalid pay_period_frequency" }, { status: 400 });
  }

  const validFreqs = ["daily", "weekly", "biweekly"];
  if (tip_pool_frequency && !validFreqs.includes(tip_pool_frequency)) {
    return NextResponse.json({ error: "Invalid tip_pool_frequency" }, { status: 400 });
  }
  if (guaranteed_min_frequency && !validFreqs.includes(guaranteed_min_frequency)) {
    return NextResponse.json({ error: "Invalid guaranteed_min_frequency" }, { status: 400 });
  }

  const frequency: PayPeriodFrequency = pay_period_frequency ?? "biweekly";
  const dueDays: number = due_date_days_after_end ?? 3;

  const { data: config, error: configErr } = await supabase
    .from("payroll_config")
    .upsert(
      {
        effective_from,
        base_rate_cents,
        guaranteed_rate_cents,
        reported_cash_tips_divisor: reported_cash_tips_divisor ?? 10,
        tip_distribution_model: tip_distribution_model ?? "proportional_hours",
        pay_period_frequency: frequency,
        tip_pool_frequency: tip_pool_frequency ?? "biweekly",
        guaranteed_min_frequency: guaranteed_min_frequency ?? "biweekly",
        due_date_days_after_end: dueDays,
      },
      { onConflict: "effective_from" }
    )
    .select()
    .single();

  if (configErr) return apiError(configErr.message);

  // Only auto-create a period on first-time setup (no periods exist yet).
  // Mid-cycle config updates must not generate new periods — use + New Period or the cron.
  const { count } = await supabase
    .from("pay_periods")
    .select("id", { count: "exact", head: true });

  let periodCreated = false;
  if ((count ?? 0) === 0) {
    const today = new Date().toISOString().slice(0, 10);
    const dates = computeNextPeriodDates(null, frequency, today);
    const due_date = addDays(dates.end_date, dueDays);

    const { error: insertErr } = await supabase
      .from("pay_periods")
      .insert({ ...dates, due_date, status: "open" });

    if (insertErr) return apiError(insertErr.message);
    periodCreated = true;
  }

  return NextResponse.json({ config, periodCreated });
}

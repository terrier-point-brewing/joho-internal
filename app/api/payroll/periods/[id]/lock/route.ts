import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP, getSessionUser } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";
import { buildPayrollPreview } from "@/lib/payroll/previewService";
import { unattributedBuckets, exclusionDrift, type DayOverride, type TipDayExclusion } from "@/lib/payroll/dailyGrid";
import type { PayPeriod, PayrollConfig, Employee, PayrollEntry } from "@/lib/payroll/types";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try { await requirePermission(CAP.payrollManage); } catch (res) { return res as Response; }

  const session = await getSessionUser();
  const supabase = await createSupabaseServerClient();
  const { id } = await params;

  const { data: period, error: pErr } = await supabase
    .from("pay_periods")
    .select("*")
    .eq("id", id)
    .single();

  if (pErr || !period) return apiError("Period not found", 404);
  if (period.status === "locked") return NextResponse.json({ error: "Already locked" }, { status: 409 });

  // Build final preview to snapshot
  const [
    { data: employees }, { data: storedEntries },
    { data: dayOverrides, error: ovErr }, { data: exclusionRows, error: xErr },
  ] = await Promise.all([
    supabase.from("employees").select("*").eq("active", true),
    supabase.from("payroll_entries").select("*").eq("pay_period_id", id),
    supabase
      .from("payroll_shift_overrides")
      .select("employee_id, work_date, adj_hours, adj_paycheck_tips_cents, adj_cash_tips_cents, note")
      .eq("pay_period_id", id),
    supabase
      .from("payroll_tip_day_exclusions")
      .select("work_date, amount_cents, reason")
      .eq("pay_period_id", id),
  ]);

  if (ovErr) return apiError(ovErr.message);
  if (xErr) return apiError(xErr.message);
  const exclusions = (exclusionRows ?? []) as TipDayExclusion[];

  const { data: configRow, error: cErr } = await supabase
    .from("payroll_config")
    .select("*")
    .order("effective_from", { ascending: false })
    .limit(1)
    .single();

  if (cErr || !configRow) return apiError("No payroll config found", 422);

  let preview;
  try {
    preview = await buildPayrollPreview(
      period as PayPeriod,
      (employees ?? []) as Employee[],
      configRow as PayrollConfig,
      (storedEntries ?? []) as PayrollEntry[],
      (dayOverrides ?? []) as DayOverride[],
      exclusions,
    );
  } catch (err) {
    return apiError(err instanceof Error ? err.message : String(err));
  }

  const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
  const toBuckets = () => preview.tip_buckets.map(b => ({
    label: b.label,
    days: b.days,
    pool_cents: b.tipsPooledCents,
    pinned_cents: 0,
    attributed_cents: b.tipsAttributedCents,
    excluded_cents: b.tipsExcludedCents,
    exclusions: b.exclusions,
    pinned_on_excluded_cents: 0,
  }));

  // Gate: an exclusion is a statement about a specific amount. If the day's
  // pool moved since it was saved (late refund, re-sync), a human re-saves it
  // — the lock never carries the new figure forward on its own.
  const drift = exclusionDrift(toBuckets());
  if (drift.length > 0) {
    return NextResponse.json({
      error:
        `An excluded day's card-tip pool has changed since it was excluded. ` +
        `Remove and re-exclude it on the Shifts tab: ` +
        drift.map(d => `${d.date} (excluded at ${usd(d.snapshotCents)}, now ${usd(d.liveCents)})`).join(", "),
      exclusion_drift: drift,
    }, { status: 422 });
  }

  // Gate: a pool that never landed on anyone. Locking snapshots the tips as
  // paid, so an unattributed bucket freezes money out of payroll permanently
  // and shows up later as taproom-vs-app drift. The fix is a day override on
  // the named days (Shifts tab, override mode) — or, when nobody tip-eligible
  // worked, excluding the day's pool from payroll on the record (it then stays
  // in GL 2310 for finance). Which is why the days are in the message — not
  // loosening this check.
  const unattributed = unattributedBuckets(toBuckets());
  if (unattributed.length > 0) {
    const total = unattributed.reduce((s, b) => s + b.shortfallCents, 0);
    return NextResponse.json({
      error:
        `${usd(total)} of card tips has no eligible employee to land on. ` +
        `On the Shifts tab, add a day override or exclude the day's card tips for: ` +
        unattributed
          .map(b => `${b.label} (${usd(b.shortfallCents)})`)
          .join(", "),
      unattributed_buckets: unattributed,
    }, { status: 422 });
  }

  // Upsert final snapshotted values for all hourly tipped employees
  const upserts = preview.entries.map((entry) => ({
    pay_period_id: id,
    employee_id: entry.employee_id,
    hours_worked: entry.effective_hours,
    paycheck_tips_cents: entry.effective_paycheck_tips_cents,
    cash_tips_cents: entry.effective_cash_tips_cents,
    reported_cash_tips_cents: entry.effective_reported_cash_tips_cents,
    bonus_cents: entry.effective_bonus_cents,
    adj_hours_worked: entry.adj_hours_worked,
    adj_paycheck_tips_cents: entry.adj_paycheck_tips_cents,
    adj_cash_tips_cents: entry.adj_cash_tips_cents,
    adj_reported_cash_tips_cents: entry.adj_reported_cash_tips_cents,
    adj_bonus_cents: entry.adj_bonus_cents,
    admin_notes: entry.admin_notes,
  }));

  if (upserts.length > 0) {
    const { error: uErr } = await supabase
      .from("payroll_entries")
      .upsert(upserts, { onConflict: "pay_period_id,employee_id" });
    if (uErr) return apiError(uErr.message);
  }

  // Lock the period. excluded_tips_cents freezes what Square pooled but payroll
  // deliberately did not pay out — it is NOT in any payroll_entries row, so GL
  // readers never see it as disbursed; it stays in GL 2310 for finance.
  const { data: locked, error: lErr } = await supabase
    .from("pay_periods")
    .update({
      status: "locked",
      locked_at: new Date().toISOString(),
      locked_by: session!.user.id,
      excluded_tips_cents: preview.total_excluded_tips_cents,
    })
    .eq("id", id)
    .select()
    .single();

  if (lErr) return apiError(lErr.message);
  return NextResponse.json(locked);
}

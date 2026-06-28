import { NextRequest, NextResponse } from "next/server";
import { requireRole, getSessionUser } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";
import { buildPayrollPreview } from "@/lib/payroll/previewService";
import type { PayPeriod, PayrollConfig, Employee, PayrollEntry } from "@/lib/payroll/types";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try { await requireRole([]); } catch (res) { return res as Response; }

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
  const [{ data: employees }, { data: storedEntries }] = await Promise.all([
    supabase.from("employees").select("*").eq("active", true),
    supabase.from("payroll_entries").select("*").eq("pay_period_id", id),
  ]);

  const { data: configRow } = await supabase
    .from("payroll_config")
    .select("*")
    .lte("effective_from", (period as PayPeriod).start_date)
    .order("effective_from", { ascending: false })
    .limit(1)
    .single();

  const preview = await buildPayrollPreview(
    period as PayPeriod,
    (employees ?? []) as Employee[],
    configRow as PayrollConfig,
    (storedEntries ?? []) as PayrollEntry[]
  );

  // Upsert final snapshotted values for all hourly tipped employees
  const upserts = preview.entries.map((entry) => ({
    pay_period_id: id,
    employee_id: entry.employee_id,
    hours_worked: entry.effective_hours,
    paycheck_tips_cents: entry.effective_paycheck_tips_cents,
    cash_tips_cents: entry.effective_cash_tips_cents,
    bonus_cents: entry.effective_bonus_cents,
    adj_hours_worked: entry.adj_hours_worked,
    adj_paycheck_tips_cents: entry.adj_paycheck_tips_cents,
    adj_cash_tips_cents: entry.adj_cash_tips_cents,
    adj_bonus_cents: entry.adj_bonus_cents,
    admin_notes: entry.admin_notes,
  }));

  if (upserts.length > 0) {
    const { error: uErr } = await supabase
      .from("payroll_entries")
      .upsert(upserts, { onConflict: "pay_period_id,employee_id" });
    if (uErr) return apiError(uErr.message);
  }

  // Lock the period
  const { data: locked, error: lErr } = await supabase
    .from("pay_periods")
    .update({ status: "locked", locked_at: new Date().toISOString(), locked_by: session!.user.id })
    .eq("id", id)
    .select()
    .single();

  if (lErr) return apiError(lErr.message);
  return NextResponse.json(locked);
}

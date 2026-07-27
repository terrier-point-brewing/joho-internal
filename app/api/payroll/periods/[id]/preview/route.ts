import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";
import { buildPayrollPreview } from "@/lib/payroll/previewService";
import type { DayOverride } from "@/lib/payroll/dailyGrid";
import type { PayPeriod, PayrollConfig, Employee, PayrollEntry } from "@/lib/payroll/types";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try { await requirePermission(CAP.payrollRead); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { id } = await params;

  const [{ data: period, error: pErr }, { data: employees, error: eErr }, { data: config, error: cErr }] =
    await Promise.all([
      supabase.from("pay_periods").select("*").eq("id", id).single(),
      supabase.from("employees").select("*").eq("active", true).order("last_name"),
      supabase.from("payroll_config").select("*").order("effective_from", { ascending: false }).limit(1).single(),
    ]);

  if (pErr) return apiError(pErr.message, 404);
  if (eErr) return apiError(eErr.message);
  if (cErr) return apiError("No payroll config found", 422);

  // Locked periods use the config that was active at their start date (historical accuracy).
  // Open periods always use the latest config so in-flight setting changes take effect immediately.
  let activeConfig = config as PayrollConfig;
  if ((period as PayPeriod).status === "locked") {
    const { data: periodConfig } = await supabase
      .from("payroll_config")
      .select("*")
      .lte("effective_from", (period as PayPeriod).start_date)
      .order("effective_from", { ascending: false })
      .limit(1)
      .single();
    if (periodConfig) activeConfig = periodConfig as PayrollConfig;
  }

  const [{ data: storedEntries }, { data: dayOverrides }] = await Promise.all([
    supabase.from("payroll_entries").select("*").eq("pay_period_id", id),
    supabase
      .from("payroll_shift_overrides")
      .select("employee_id, work_date, adj_hours, adj_paycheck_tips_cents, adj_cash_tips_cents, note")
      .eq("pay_period_id", id),
  ]);

  let preview;
  try {
    preview = await buildPayrollPreview(
      period as PayPeriod,
      employees as Employee[],
      activeConfig,
      (storedEntries ?? []) as PayrollEntry[],
      (dayOverrides ?? []) as DayOverride[]
    );
  } catch (err) {
    return apiError(err instanceof Error ? err.message : String(err));
  }

  return NextResponse.json(preview);
}

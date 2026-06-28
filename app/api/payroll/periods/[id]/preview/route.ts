import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";
import { buildPayrollPreview } from "@/lib/payroll/previewService";
import type { PayPeriod, PayrollConfig, Employee, PayrollEntry } from "@/lib/payroll/types";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try { await requireRole(["manager"]); } catch (res) { return res as Response; }

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

  // Fetch the config version active at the period start date
  const { data: periodConfig } = await supabase
    .from("payroll_config")
    .select("*")
    .lte("effective_from", (period as PayPeriod).start_date)
    .order("effective_from", { ascending: false })
    .limit(1)
    .single();

  const activeConfig = (periodConfig ?? config) as PayrollConfig;

  const { data: storedEntries } = await supabase
    .from("payroll_entries")
    .select("*")
    .eq("pay_period_id", id);

  const preview = await buildPayrollPreview(
    period as PayPeriod,
    employees as Employee[],
    activeConfig,
    (storedEntries ?? []) as PayrollEntry[]
  );

  return NextResponse.json(preview);
}

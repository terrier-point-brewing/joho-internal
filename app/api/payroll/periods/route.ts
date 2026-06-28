import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";
import { computeNextPeriodDates } from "@/lib/payroll/periodUtils";
import type { PayPeriodFrequency } from "@/lib/payroll/periodUtils";

export const dynamic = "force-dynamic";

export async function GET() {
  try { await requireRole(["manager"]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("pay_periods")
    .select("*")
    .order("start_date", { ascending: false });

  if (error) return apiError(error.message);
  return NextResponse.json(data);
}

export async function POST(_req: NextRequest) {
  try { await requireRole([]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();

  const { data: config, error: configErr } = await supabase
    .from("payroll_config")
    .select("first_pay_period_start_date, pay_period_frequency")
    .order("effective_from", { ascending: false })
    .limit(1)
    .single();

  if (configErr) return apiError("No payroll config found — seed one first", 422);

  const { data: lastPeriod } = await supabase
    .from("pay_periods")
    .select("end_date")
    .order("end_date", { ascending: false })
    .limit(1)
    .single();

  const dates = computeNextPeriodDates(
    config.first_pay_period_start_date,
    lastPeriod?.end_date ?? null,
    (config.pay_period_frequency ?? "biweekly") as PayPeriodFrequency
  );

  const { data, error } = await supabase
    .from("pay_periods")
    .insert({ ...dates, status: "open" })
    .select()
    .single();

  if (error) return apiError(error.message);
  return NextResponse.json(data, { status: 201 });
}

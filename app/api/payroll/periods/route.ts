import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";
import { computeNextPeriodDates, addDays } from "@/lib/payroll/periodUtils";
import type { PayPeriodFrequency } from "@/lib/payroll/periodUtils";
import { getPeriodSummaries } from "@/lib/payroll/periodSummary";

export const dynamic = "force-dynamic";

export async function GET() {
  try { await requireRole(["manager"]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  try {
    const summaries = await getPeriodSummaries(supabase);
    return NextResponse.json(summaries);
  } catch (err) {
    return apiError(err instanceof Error ? err.message : String(err));
  }
}

export async function POST(req: NextRequest) {
  try { await requireRole([]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const body = await req.json().catch(() => ({}));
  const { start_date: bodyStart, end_date: bodyEnd } = body;

  const { data: config, error: configErr } = await supabase
    .from("payroll_config")
    .select("pay_period_frequency, due_date_days_after_end")
    .order("effective_from", { ascending: false })
    .limit(1)
    .single();

  if (configErr) return apiError("No payroll config found — save settings first", 422);

  const dueDays: number = config.due_date_days_after_end ?? 3;

  let dates: { start_date: string; end_date: string };
  if (bodyStart && bodyEnd) {
    dates = { start_date: bodyStart, end_date: bodyEnd };
  } else {
    const { data: lastPeriod } = await supabase
      .from("pay_periods")
      .select("end_date")
      .order("end_date", { ascending: false })
      .limit(1)
      .maybeSingle();

    const frequency = (config.pay_period_frequency ?? "biweekly") as PayPeriodFrequency;
    dates = computeNextPeriodDates(lastPeriod?.end_date ?? null, frequency);
  }

  const due_date = addDays(dates.end_date, dueDays);

  const { data, error } = await supabase
    .from("pay_periods")
    .insert({ ...dates, due_date, status: "open" })
    .select()
    .single();

  if (error) return apiError(error.message);
  return NextResponse.json(data, { status: 201 });
}

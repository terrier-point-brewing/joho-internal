import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";
import { computeNextPeriodDates } from "@/lib/payroll/periodUtils";
import type { PayPeriodFrequency } from "@/lib/payroll/periodUtils";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = await createSupabaseServerClient();

  const { data: config, error: configErr } = await supabase
    .from("payroll_config")
    .select("first_pay_period_start_date, pay_period_frequency")
    .order("effective_from", { ascending: false })
    .limit(1)
    .single();

  if (configErr) return apiError("No payroll config", 422);

  const { data: lastPeriod } = await supabase
    .from("pay_periods")
    .select("end_date")
    .order("end_date", { ascending: false })
    .limit(1)
    .single();

  const today = new Date().toISOString().slice(0, 10);

  // Only create a new period if today has reached or passed the last period's end date.
  if (lastPeriod && lastPeriod.end_date > today) {
    return NextResponse.json({ created: false });
  }

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
  return NextResponse.json({ created: true, period: data });
}

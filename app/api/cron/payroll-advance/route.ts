import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { runCronJob } from "@/lib/cron/runCronJob";
import { apiError } from "@/lib/utils/api";
import { computeNextPeriodDates, addDays } from "@/lib/payroll/periodUtils";
import type { PayPeriodFrequency } from "@/lib/payroll/periodUtils";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const outcome = await runCronJob("payroll-advance", async () => {
    const supabase = await createSupabaseServerClient();

    const { data: config, error: configErr } = await supabase
      .from("payroll_config")
      .select("pay_period_frequency, due_date_days_after_end")
      .order("effective_from", { ascending: false })
      .limit(1)
      .single();

    // Not configured yet — a no-op, not an error.
    if (configErr) return { created: false, reason: "no payroll config" };

    const { data: latestPeriod } = await supabase
      .from("pay_periods")
      .select("start_date, end_date")
      .order("start_date", { ascending: false })
      .limit(1)
      .maybeSingle();

    // No periods yet — user hasn't saved settings. Nothing to do.
    if (!latestPeriod) return { created: false, reason: "no periods yet" };

    const today = new Date().toISOString().slice(0, 10);

    // The latest period is still in the future — next period already exists ahead of us.
    if (today < latestPeriod.start_date) return { created: false, reason: "next period already ahead" };

    // We're inside (or past) the current period — create the next one proactively.
    const frequency = (config.pay_period_frequency ?? "biweekly") as PayPeriodFrequency;
    const dueDays: number = config.due_date_days_after_end ?? 3;
    const dates = computeNextPeriodDates(latestPeriod.end_date, frequency);
    const due_date = addDays(dates.end_date, dueDays);

    const { data, error } = await supabase
      .from("pay_periods")
      .upsert({ ...dates, due_date, status: "open" }, { onConflict: "start_date", ignoreDuplicates: true })
      .select()
      .maybeSingle();

    if (error) throw new Error(error.message);
    // Period already existed (idempotent re-run) — not an error.
    if (!data) return { created: false, reason: "already existed" };
    return { created: true, period: data };
  });

  return outcome.ok ? NextResponse.json(outcome.detail) : apiError(outcome.error);
}

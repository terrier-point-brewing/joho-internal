/**
 * Creates the next open pay period once the current one has ended.
 *
 * Safe to re-run at any time: it does nothing at all unless the latest period's
 * end date is already in the past, and the insert ignores a duplicate, so a
 * second run in the same day reports "already existed" rather than doubling up.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { computeNextPeriodDates, addDays } from "@/lib/payroll/periodUtils";
import type { PayPeriodFrequency } from "@/lib/payroll/periodUtils";

export async function runPayrollAdvance(supabase: SupabaseClient) {
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

  // The latest period hasn't ended yet — it's still the current (or a future)
  // period, so there's nothing to roll forward. We intentionally do NOT create
  // the next period until the current one is over, to avoid running the
  // schedule a full period ahead of today.
  if (today <= latestPeriod.end_date) return { created: false, reason: "current period still active" };

  // The latest period has ended — create the next one.
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
}

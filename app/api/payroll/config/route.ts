import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";
import { seedPeriodDates } from "@/lib/payroll/periodUtils";
import type { PayPeriodFrequency } from "@/lib/payroll/periodUtils";

export const dynamic = "force-dynamic";

export async function GET() {
  try { await requireRole([]); } catch (res) { return res as Response; }

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
  try { await requireRole([]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const body = await req.json();
  const {
    effective_from,
    base_rate_cents,
    guaranteed_rate_cents,
    cash_tips_rate,
    tip_distribution_model,
    first_pay_period_start_date,
    pay_period_frequency,
  } = body;

  if (!effective_from || !base_rate_cents || !guaranteed_rate_cents || !first_pay_period_start_date) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const frequency: PayPeriodFrequency = pay_period_frequency ?? "biweekly";

  // Upsert on effective_from so multiple saves on the same day don't conflict.
  const { data: config, error: configErr } = await supabase
    .from("payroll_config")
    .upsert(
      {
        effective_from,
        base_rate_cents,
        guaranteed_rate_cents,
        cash_tips_rate: cash_tips_rate ?? 0.01,
        tip_distribution_model: tip_distribution_model ?? "proportional_hours",
        first_pay_period_start_date,
        pay_period_frequency: frequency,
      },
      { onConflict: "effective_from" }
    )
    .select()
    .single();

  if (configErr) return apiError(configErr.message);

  // Seed all missing periods from first_pay_period_start_date through today.
  const today = new Date().toISOString().slice(0, 10);
  const expected = seedPeriodDates(first_pay_period_start_date, frequency, today);

  const { data: existing } = await supabase
    .from("pay_periods")
    .select("start_date");

  const existingStarts = new Set((existing ?? []).map((p: { start_date: string }) => p.start_date));
  const toInsert = expected
    .filter(p => !existingStarts.has(p.start_date))
    .map(p => ({ ...p, status: "open" as const }));

  if (toInsert.length > 0) {
    const { error: insertErr } = await supabase.from("pay_periods").insert(toInsert);
    if (insertErr) return apiError(insertErr.message);
  }

  return NextResponse.json({ config, periodsCreated: toInsert.length });
}

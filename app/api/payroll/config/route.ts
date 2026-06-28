import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";

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
  } = body;

  if (!effective_from || !base_rate_cents || !guaranteed_rate_cents || !first_pay_period_start_date) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("payroll_config")
    .insert({
      effective_from,
      base_rate_cents,
      guaranteed_rate_cents,
      cash_tips_rate: cash_tips_rate ?? 0.01,
      tip_distribution_model: tip_distribution_model ?? "proportional_hours",
      first_pay_period_start_date,
    })
    .select()
    .single();

  if (error) return apiError(error.message);
  return NextResponse.json(data);
}

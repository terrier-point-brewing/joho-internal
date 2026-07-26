import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; employeeId: string }> }
) {
  try { await requirePermission(CAP.payrollManage); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { id: pay_period_id, employeeId: employee_id } = await params;

  // Verify period is still open
  const { data: period } = await supabase
    .from("pay_periods")
    .select("status")
    .eq("id", pay_period_id)
    .single();

  if (!period || period.status !== "open") {
    return NextResponse.json({ error: "Period is locked" }, { status: 409 });
  }

  const body = await req.json();
  const allowed = ["adj_hours_worked", "adj_paycheck_tips_cents", "adj_cash_tips_cents", "adj_reported_cash_tips_cents", "adj_bonus_cents", "admin_notes"];
  const update = Object.fromEntries(Object.entries(body).filter(([k]) => allowed.includes(k)));

  const { data, error } = await supabase
    .from("payroll_entries")
    .upsert({ pay_period_id, employee_id, ...update }, { onConflict: "pay_period_id,employee_id" })
    .select()
    .single();

  if (error) return apiError(error.message);
  return NextResponse.json(data);
}

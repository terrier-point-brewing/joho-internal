/**
 * Gusto payroll-journal report for a pay period. POST accepts
 * multipart/form-data (field "file") and uploads/parses/persists it via
 * lib/payroll/gustoUpload.ts's uploadGustoReport, using the private
 * payroll-gl-reports Storage bucket through the service-role admin client
 * (the bucket has no object-level RLS policies, so this route is the only
 * path in). GET returns the period's active report (or null) + totals +
 * unmapped-department warnings + the parsed per-employee audit rows +
 * every expense currently matched to this period (id/amount/merchant/date) --
 * the latter always populated even with no active report, so the Gusto
 * Upload UI (Task 11) can show a "transactions waiting on upload" banner
 * before any file has ever been uploaded. Manager+ (same gate as the tax
 * task files route).
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { uploadGustoReport, getActiveGustoReport } from "@/lib/payroll/gustoUpload";
import type { PayrollGlReportEmployee } from "@/lib/payroll/types";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requirePermission(CAP.payrollOperate); } catch (res) { return res as Response; }

  const { id } = await params;
  try {
    let formData: FormData;
    try {
      formData = await req.formData();
    } catch {
      return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
    }

    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const session = await getSessionUser();
    const sb = createSupabaseAdminClient();
    const result = await uploadGustoReport(sb, {
      payPeriodId: id,
      file,
      fileName: file.name,
      userId: session!.user.id,
    });

    const { data: employeeRows, error: employeesErr } = await sb
      .from("payroll_gl_report_employees")
      .select("*")
      .eq("report_id", result.report.id)
      .order("last_name", { ascending: true });
    if (employeesErr) throw new Error(employeesErr.message);

    return NextResponse.json({ ...result, employees: (employeeRows ?? []) as PayrollGlReportEmployee[] }, { status: 201 });
  } catch (err) {
    return apiError(err);
  }
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requirePermission(CAP.payrollRead); } catch (res) { return res as Response; }

  const { id } = await params;
  try {
    const sb = createSupabaseAdminClient();
    const active = await getActiveGustoReport(sb, id);

    let employees: PayrollGlReportEmployee[] = [];
    if (active) {
      const { data, error } = await sb
        .from("payroll_gl_report_employees")
        .select("*")
        .eq("report_id", active.report.id)
        .order("last_name", { ascending: true });
      if (error) throw new Error(error.message);
      employees = (data ?? []) as PayrollGlReportEmployee[];
    }

    const { data: matchRows, error: matchErr } = await sb
      .from("payroll_period_expense_matches")
      .select("expense_id")
      .eq("pay_period_id", id);
    if (matchErr) throw new Error(matchErr.message);
    const expenseIds = ((matchRows ?? []) as { expense_id: string }[]).map((r) => r.expense_id);

    let matchedExpenses: { expenseId: string; amountCents: number; merchantName: string | null; accountingDate: string | null }[] = [];
    if (expenseIds.length > 0) {
      const { data: expenseRows, error: expErr } = await sb
        .from("expenses")
        .select("id, amount_cents, merchant_name, accounting_date")
        .in("id", expenseIds);
      if (expErr) throw new Error(expErr.message);
      matchedExpenses = (
        (expenseRows ?? []) as { id: string; amount_cents: number | null; merchant_name: string | null; accounting_date: string | null }[]
      ).map((r) => ({
        expenseId: r.id,
        amountCents: Math.abs(r.amount_cents ?? 0),
        merchantName: r.merchant_name,
        accountingDate: r.accounting_date,
      }));
    }

    return NextResponse.json({
      report: active?.report ?? null,
      totals: active?.totals ?? [],
      unmappedDepartments: active?.unmappedDepartments ?? [],
      employees,
      matchedExpenses,
    });
  } catch (err) {
    return apiError(err);
  }
}

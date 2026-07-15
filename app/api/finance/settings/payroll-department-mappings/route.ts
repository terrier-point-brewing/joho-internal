/**
 * Payroll department -> GL account mapping settings, consumed by
 * lib/payroll/gustoUpload.ts's uploadGustoReport (bucketing each Gusto
 * employee's gross wages by department) and by the payroll-taxes single
 * bucket (payroll_gl_settings.payroll_taxes_chart_of_accounts_id, summing
 * employer tax across every department into one account). GET reads both;
 * PUT replaces the full mapping set and upserts the singleton settings row.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

export interface PayrollDepartmentGlMapping {
  id: string;
  department_name: string;
  chart_of_accounts_id: string;
  created_at: string;
  updated_at: string;
}

export async function GET() {
  try { await requireRole(["manager"]); } catch (res) { return res as Response; }

  try {
    const sb = createSupabaseAdminClient();
    const [mappingsResult, settingsResult] = await Promise.all([
      sb.from("payroll_department_gl_mappings").select("*").order("department_name", { ascending: true }),
      sb.from("payroll_gl_settings").select("payroll_taxes_chart_of_accounts_id").maybeSingle(),
    ]);
    if (mappingsResult.error) throw new Error(mappingsResult.error.message);
    if (settingsResult.error) throw new Error(settingsResult.error.message);

    return NextResponse.json({
      mappings: (mappingsResult.data ?? []) as PayrollDepartmentGlMapping[],
      payrollTaxesAccountId:
        (settingsResult.data as { payroll_taxes_chart_of_accounts_id: string } | null)?.payroll_taxes_chart_of_accounts_id ??
        null,
    });
  } catch (err) {
    return apiError(err);
  }
}

export async function PUT(req: NextRequest) {
  try { await requireRole(["manager"]); } catch (res) { return res as Response; }

  try {
    const body = (await req.json()) as {
      mappings: { departmentName: string; chartOfAccountsId: string }[];
      payrollTaxesAccountId: string;
    };
    if (!body.payrollTaxesAccountId) return apiError("payrollTaxesAccountId required", 400);

    const sb = createSupabaseAdminClient();

    // Replace the full mapping set: delete everything, then insert the
    // submitted rows -- guarantees no stale department removed from the
    // submitted list is left behind.
    const { error: deleteErr } = await sb
      .from("payroll_department_gl_mappings")
      .delete()
      .not("id", "is", null);
    if (deleteErr) throw new Error(deleteErr.message);

    if (body.mappings.length > 0) {
      const { error: insertErr } = await sb.from("payroll_department_gl_mappings").insert(
        body.mappings.map((m) => ({
          department_name: m.departmentName,
          chart_of_accounts_id: m.chartOfAccountsId,
        })),
      );
      if (insertErr) throw new Error(insertErr.message);
    }

    const { error: settingsErr } = await sb
      .from("payroll_gl_settings")
      .upsert({ id: true, payroll_taxes_chart_of_accounts_id: body.payrollTaxesAccountId }, { onConflict: "id" });
    if (settingsErr) throw new Error(settingsErr.message);

    const { data: mappings, error: reselectErr } = await sb
      .from("payroll_department_gl_mappings")
      .select("*")
      .order("department_name", { ascending: true });
    if (reselectErr) throw new Error(reselectErr.message);

    return NextResponse.json({
      mappings: (mappings ?? []) as PayrollDepartmentGlMapping[],
      payrollTaxesAccountId: body.payrollTaxesAccountId,
    });
  } catch (err) {
    return apiError(err);
  }
}

/**
 * Payroll department -> GL account mapping settings, consumed by
 * lib/payroll/gustoUpload.ts's uploadGustoReport (bucketing each Gusto
 * employee's gross wages by department), by the payroll-taxes single
 * bucket (payroll_gl_settings.payroll_taxes_chart_of_accounts_id, summing
 * employer tax across every department into one account), and by the tips
 * liability bucket (payroll_gl_settings.tips_chart_of_accounts_id, where
 * paycheck tips post as a balance-sheet pass-through instead of a wage
 * expense), and by the taproom bucket
 * (payroll_gl_settings.taproom_chart_of_accounts_id — the one wage account
 * whose staff the app tracks via Square shifts, so lib/payroll/periodSummary.ts
 * knows which wages it may check and which it may only display). GET reads all
 * four; PUT replaces the full mapping set and upserts the singleton settings row.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
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
  try { await requirePermission(CAP.payrollRead); } catch (res) { return res as Response; }

  try {
    const sb = createSupabaseAdminClient();
    const [mappingsResult, settingsResult] = await Promise.all([
      sb.from("payroll_department_gl_mappings").select("*").order("department_name", { ascending: true }),
      sb
        .from("payroll_gl_settings")
        .select("payroll_taxes_chart_of_accounts_id, tips_chart_of_accounts_id, taproom_chart_of_accounts_id")
        .maybeSingle(),
    ]);
    if (mappingsResult.error) throw new Error(mappingsResult.error.message);
    if (settingsResult.error) throw new Error(settingsResult.error.message);

    const settings = settingsResult.data as
      | {
          payroll_taxes_chart_of_accounts_id: string;
          tips_chart_of_accounts_id: string | null;
          taproom_chart_of_accounts_id: string | null;
        }
      | null;

    return NextResponse.json({
      mappings: (mappingsResult.data ?? []) as PayrollDepartmentGlMapping[],
      payrollTaxesAccountId: settings?.payroll_taxes_chart_of_accounts_id ?? null,
      tipsAccountId: settings?.tips_chart_of_accounts_id ?? null,
      taproomAccountId: settings?.taproom_chart_of_accounts_id ?? null,
    });
  } catch (err) {
    return apiError(err);
  }
}

export async function PUT(req: NextRequest) {
  try { await requirePermission(CAP.payrollOperate); } catch (res) { return res as Response; }

  try {
    const body = (await req.json()) as {
      mappings: { departmentName: string; chartOfAccountsId: string }[];
      payrollTaxesAccountId: string;
      tipsAccountId: string;
      // Optional: an unset taproom account is a valid state — the periods
      // table reports its taproom check as unavailable rather than guessing.
      taproomAccountId?: string | null;
    };
    if (!body.payrollTaxesAccountId) return apiError("payrollTaxesAccountId required", 400);
    if (!body.tipsAccountId) return apiError("tipsAccountId required", 400);

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
      .upsert(
        {
          id: true,
          payroll_taxes_chart_of_accounts_id: body.payrollTaxesAccountId,
          tips_chart_of_accounts_id: body.tipsAccountId,
          taproom_chart_of_accounts_id: body.taproomAccountId ?? null,
        },
        { onConflict: "id" },
      );
    if (settingsErr) throw new Error(settingsErr.message);

    const { data: mappings, error: reselectErr } = await sb
      .from("payroll_department_gl_mappings")
      .select("*")
      .order("department_name", { ascending: true });
    if (reselectErr) throw new Error(reselectErr.message);

    return NextResponse.json({
      mappings: (mappings ?? []) as PayrollDepartmentGlMapping[],
      payrollTaxesAccountId: body.payrollTaxesAccountId,
      tipsAccountId: body.tipsAccountId,
      taproomAccountId: body.taproomAccountId ?? null,
    });
  } catch (err) {
    return apiError(err);
  }
}

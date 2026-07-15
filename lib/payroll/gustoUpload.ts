/**
 * Gusto payroll-journal upload/persistence — mirrors lib/tax/files.ts's
 * Storage + admin-client conventions. Bucket `payroll-gl-reports` is
 * PRIVATE (public=false) with no object-level RLS policies, so every call
 * here must be made with the service-role admin client
 * (`createSupabaseAdminClient()`); the anon/browser client cannot read or
 * write this bucket at all.
 *
 * Storage object path: `${payPeriodId}/${crypto.randomUUID()}-${safeName}`
 * — same random-segment-avoids-collisions, grouped-by-parent-id shape as
 * lib/tax/files.ts.
 *
 * `uploadGustoReport` supersedes (not deletes) any prior active report for
 * the period, then uploads -> parses -> persists report/employees/totals in
 * that order, so the DB never references a Storage object that doesn't
 * exist and a failed insert never leaves a half-written report visible.
 *
 * `uploadGustoReport` deliberately does NOT recompute already-matched
 * expenses' GL splits — see Task 8/Task 11 in the implementation plan.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseGustoPayrollJournal, computeGlBucketTotals } from "./gustoParser";
import type { PayrollGlReport, PayrollGlReportTotal } from "./types";

const BUCKET = "payroll-gl-reports";

export interface UploadGustoReportInput {
  payPeriodId: string;
  file: File | Blob | Buffer;
  fileName: string;
  userId: string;
}

export interface GustoReportResult {
  report: PayrollGlReport;
  totals: PayrollGlReportTotal[];
  unmappedDepartments: string[];
}

async function fileToText(file: File | Blob | Buffer): Promise<string> {
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(file)) return file.toString("utf-8");
  return await (file as Blob).text();
}

/**
 * Marks any existing active report for payPeriodId as superseded (sets
 * superseded_at), uploads the file to the "payroll-gl-reports" Storage
 * bucket, parses it, persists payroll_gl_reports +
 * payroll_gl_report_employees + payroll_gl_report_totals, and returns the
 * new report row plus computed totals.
 */
export async function uploadGustoReport(sb: SupabaseClient, input: UploadGustoReportInput): Promise<GustoReportResult> {
  const { error: supersedeError } = await sb
    .from("payroll_gl_reports")
    .update({ superseded_at: new Date().toISOString() })
    .eq("pay_period_id", input.payPeriodId)
    .is("superseded_at", null);
  if (supersedeError) throw new Error(supersedeError.message);

  // input.fileName is user-supplied (from File.name) — strip any path
  // separators so it can't escape the `${payPeriodId}/` key grouping. Same
  // sanitization as lib/tax/files.ts's uploadTaskFile.
  const safeName = input.fileName.split(/[\\/]/).pop()!.replace(/[\\/]/g, "_") || "file";
  const storagePath = `${input.payPeriodId}/${crypto.randomUUID()}-${safeName}`;

  const { error: uploadError } = await sb.storage.from(BUCKET).upload(storagePath, input.file);
  if (uploadError) throw new Error(uploadError.message);

  const csvText = await fileToText(input.file);
  const parsed = parseGustoPayrollJournal(csvText);

  const [mappingsResult, settingsResult] = await Promise.all([
    sb.from("payroll_department_gl_mappings").select("department_name, chart_of_accounts_id"),
    sb.from("payroll_gl_settings").select("payroll_taxes_chart_of_accounts_id").single(),
  ]);
  if (mappingsResult.error) throw new Error(mappingsResult.error.message);
  if (settingsResult.error) throw new Error(settingsResult.error.message);

  const departmentMap = new Map<string, string>(
    (mappingsResult.data ?? []).map((row: { department_name: string; chart_of_accounts_id: string }) => [
      row.department_name,
      row.chart_of_accounts_id,
    ]),
  );
  const payrollTaxesAccountId = (
    settingsResult.data as { payroll_taxes_chart_of_accounts_id: string }
  ).payroll_taxes_chart_of_accounts_id;

  const buckets = computeGlBucketTotals(parsed, departmentMap, payrollTaxesAccountId);

  const { data: reportRow, error: reportError } = await sb
    .from("payroll_gl_reports")
    .insert({
      pay_period_id: input.payPeriodId,
      storage_path: storagePath,
      original_filename: input.fileName,
      uploaded_by: input.userId,
    })
    .select()
    .single();
  if (reportError) throw new Error(reportError.message);
  const report = reportRow as PayrollGlReport;

  if (parsed.employees.length > 0) {
    const { error: employeesError } = await sb.from("payroll_gl_report_employees").insert(
      parsed.employees.map((employee) => ({
        report_id: report.id,
        last_name: employee.lastName,
        first_name: employee.firstName,
        department: employee.department,
        job: employee.job,
        pay_type: employee.payType,
        gross_amount_cents: employee.grossAmountCents,
        employer_tax_cents: employee.employerTaxCents,
      })),
    );
    if (employeesError) throw new Error(employeesError.message);
  }

  let totals: PayrollGlReportTotal[] = [];
  if (buckets.length > 0) {
    const { data: totalRows, error: totalsError } = await sb
      .from("payroll_gl_report_totals")
      .insert(
        buckets.map((bucket) => ({
          report_id: report.id,
          chart_of_accounts_id: bucket.chartOfAccountsId,
          amount_cents: bucket.amountCents,
        })),
      )
      .select();
    if (totalsError) throw new Error(totalsError.message);
    totals = (totalRows ?? []) as PayrollGlReportTotal[];
  }

  return { report, totals, unmappedDepartments: parsed.unmappedDepartments };
}

/** The active (non-superseded) report for a period, its totals, and any
 * departments its employee rows carry that are no longer (or never were)
 * in payroll_department_gl_mappings — recomputed against the *current*
 * mapping so a mapping added/removed after upload is reflected live. */
export async function getActiveGustoReport(
  sb: SupabaseClient,
  payPeriodId: string,
): Promise<GustoReportResult | null> {
  const { data: reportRow, error: reportError } = await sb
    .from("payroll_gl_reports")
    .select("*")
    .eq("pay_period_id", payPeriodId)
    .is("superseded_at", null)
    .maybeSingle();
  if (reportError) throw new Error(reportError.message);
  if (!reportRow) return null;
  const report = reportRow as PayrollGlReport;

  const [totalsResult, employeesResult, mappingsResult] = await Promise.all([
    sb.from("payroll_gl_report_totals").select("*").eq("report_id", report.id),
    sb.from("payroll_gl_report_employees").select("department").eq("report_id", report.id),
    sb.from("payroll_department_gl_mappings").select("department_name"),
  ]);
  if (totalsResult.error) throw new Error(totalsResult.error.message);
  if (employeesResult.error) throw new Error(employeesResult.error.message);
  if (mappingsResult.error) throw new Error(mappingsResult.error.message);

  const mappedDepartments = new Set(
    (mappingsResult.data ?? []).map((row: { department_name: string }) => row.department_name),
  );
  const unmappedDepartments = Array.from(
    new Set(
      (employeesResult.data ?? [])
        .map((row: { department: string }) => row.department.trim())
        .filter((department: string) => !mappedDepartments.has(department)),
    ),
  );

  return {
    report,
    totals: (totalsResult.data ?? []) as PayrollGlReportTotal[],
    unmappedDepartments,
  };
}

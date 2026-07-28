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
 * `uploadGustoReport` uploads the file to Storage FIRST, before touching the
 * DB at all: if the upload fails, nothing else has changed, so any prior
 * active report for the period is left untouched. Only after the upload
 * succeeds does it parse -> insert the new payroll_gl_reports row -> insert
 * payroll_gl_report_employees -> insert payroll_gl_report_totals. If the
 * employees or totals insert fails, it compensates by deleting whatever of
 * the new report's rows it already wrote (report row, and employee rows if
 * present) before rethrowing, so a failed insert never leaves a
 * half-written report visible. The prior active report is only marked
 * superseded_at as the last step, once the new report is fully persisted —
 * so between the new report's insert and this final step there can briefly
 * be two non-superseded rows for the same pay_period_id; see
 * getActiveGustoReport's order-by-uploaded_at-desc for why that's safe to
 * read concurrently. If that final supersede UPDATE itself fails, the error
 * is surfaced but the new report is left in place (already valid) rather
 * than rolled back.
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
 * Uploads the file to the "payroll-gl-reports" Storage bucket, parses it,
 * persists payroll_gl_reports + payroll_gl_report_employees +
 * payroll_gl_report_totals, marks any existing active report for
 * payPeriodId as superseded (sets superseded_at), and returns the new
 * report row plus computed totals. See the file-level doc comment above for
 * the ordering/rollback guarantees.
 */
export async function uploadGustoReport(sb: SupabaseClient, input: UploadGustoReportInput): Promise<GustoReportResult> {
  // input.fileName is user-supplied (from File.name) — strip any path
  // separators so it can't escape the `${payPeriodId}/` key grouping. Same
  // sanitization as lib/tax/files.ts's uploadTaskFile.
  const safeName = input.fileName.split(/[\\/]/).pop()!.replace(/[\\/]/g, "_") || "file";
  const storagePath = `${input.payPeriodId}/${crypto.randomUUID()}-${safeName}`;

  // Upload FIRST, before touching the DB at all: if this fails, nothing
  // else has changed, so any prior active report for the period stays
  // untouched and active.
  const { error: uploadError } = await sb.storage.from(BUCKET).upload(storagePath, input.file);
  if (uploadError) throw new Error(uploadError.message);

  const csvText = await fileToText(input.file);
  const parsed = parseGustoPayrollJournal(csvText);

  const [mappingsResult, settingsResult] = await Promise.all([
    sb.from("payroll_department_gl_mappings").select("department_name, chart_of_accounts_id"),
    sb.from("payroll_gl_settings").select("payroll_taxes_chart_of_accounts_id, tips_chart_of_accounts_id").single(),
  ]);
  if (mappingsResult.error) throw new Error(mappingsResult.error.message);
  if (settingsResult.error) throw new Error(settingsResult.error.message);

  const departmentMap = new Map<string, string>(
    (mappingsResult.data ?? []).map((row: { department_name: string; chart_of_accounts_id: string }) => [
      row.department_name,
      row.chart_of_accounts_id,
    ]),
  );
  const settingsRow = settingsResult.data as {
    payroll_taxes_chart_of_accounts_id: string;
    tips_chart_of_accounts_id: string | null;
  };
  const payrollTaxesAccountId = settingsRow.payroll_taxes_chart_of_accounts_id;
  const tipsAccountId = settingsRow.tips_chart_of_accounts_id;
  if (!tipsAccountId) {
    throw new Error(
      "No tips account configured — set one in Finance → Settings → Payroll Departments before uploading a Gusto report.",
    );
  }

  const buckets = computeGlBucketTotals(parsed, departmentMap, payrollTaxesAccountId, tipsAccountId);

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
    if (employeesError) {
      // Compensating cleanup: nothing but the report row has been written
      // yet, so deleting it fully reverts this call. If the cleanup delete
      // itself fails, report both errors so the caller knows an orphaned row
      // may exist.
      const { error: deleteError } = await sb.from("payroll_gl_reports").delete().eq("id", report.id);
      if (deleteError) {
        throw new Error(
          `Failed to insert employees (${employeesError.message}); cleanup delete of report ${report.id} also failed (${deleteError.message}) — orphaned report row may exist`
        );
      }
      throw new Error(employeesError.message);
    }
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
          bucket_kind: bucket.kind,
        })),
      )
      .select();
    if (totalsError) {
      // Compensating cleanup: unwind both the employee rows and the report
      // row so no partial report is left behind. If either delete fails,
      // report all errors so the caller knows an orphaned row may exist.
      const { error: employeesDeleteError } = await sb
        .from("payroll_gl_report_employees")
        .delete()
        .eq("report_id", report.id);
      const { error: reportDeleteError } = await sb.from("payroll_gl_reports").delete().eq("id", report.id);

      if (employeesDeleteError || reportDeleteError) {
        const errorParts = [
          `Failed to insert totals (${totalsError.message})`,
          employeesDeleteError && `cleanup delete of employees also failed (${employeesDeleteError.message})`,
          reportDeleteError && `cleanup delete of report also failed (${reportDeleteError.message})`,
        ].filter((p) => p);
        throw new Error(`${errorParts.join("; ")} — orphaned report/employee rows may exist`);
      }
      throw new Error(totalsError.message);
    }
    totals = (totalRows ?? []) as PayrollGlReportTotal[];
  }

  // Only now, after report + employees + totals have all been successfully
  // persisted, supersede the prior active report for this period (if any).
  // Excludes the row we just inserted (also superseded_at is null at this
  // point) so it doesn't supersede itself.
  const { error: supersedeError } = await sb
    .from("payroll_gl_reports")
    .update({ superseded_at: new Date().toISOString() })
    .eq("pay_period_id", input.payPeriodId)
    .is("superseded_at", null)
    .neq("id", report.id);
  if (supersedeError) throw new Error(supersedeError.message);

  return { report, totals, unmappedDepartments: parsed.unmappedDepartments };
}

/** The active (non-superseded) report for a period, its totals, and any
 * departments its employee rows carry that are no longer (or never were)
 * in payroll_department_gl_mappings — recomputed against the *current*
 * mapping so a mapping added/removed after upload is reflected live.
 *
 * uploadGustoReport briefly leaves two non-superseded rows for the same
 * pay_period_id (the new one just inserted, the old one not yet
 * superseded) while its employees/totals inserts run. Ordering by
 * uploaded_at desc and taking the first row means a concurrent read that
 * lands in that window still returns the newest report, never an ambiguous
 * or wrong one. */
export async function getActiveGustoReport(
  sb: SupabaseClient,
  payPeriodId: string,
): Promise<GustoReportResult | null> {
  const { data: reportRow, error: reportError } = await sb
    .from("payroll_gl_reports")
    .select("*")
    .eq("pay_period_id", payPeriodId)
    .is("superseded_at", null)
    .order("uploaded_at", { ascending: false })
    .limit(1)
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

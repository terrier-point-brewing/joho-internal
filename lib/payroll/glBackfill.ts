/**
 * Backfill tool for existing payroll_gl_report_totals rows written by the
 * pre-tips parser: those rows carry no `tips` bucket, so recomputing splits
 * alone (recomputePeriodExpenseSplits) is insufficient -- the stored Gusto
 * CSV must be re-downloaded from Storage and re-parsed with the current
 * gustoParser (parseGustoPayrollJournal + computeGlBucketTotals) so its
 * totals can be rewritten with a wages/employer_tax/tips split.
 *
 * `dryRun: true` (the route's default) performs ZERO writes -- only reads
 * (payroll_gl_reports, payroll_department_gl_mappings, payroll_gl_settings,
 * payroll_gl_report_totals, and the Storage download) run, so a caller who
 * forgets the flag can never mutate anything. `dryRun: false` replaces each
 * report's totals rows and calls recomputePeriodExpenseSplits, which already
 * skips expenses carrying a split_source='manual' override and nets manual
 * tip postings out of the auto allocation -- not reimplemented here.
 *
 * A single report's failure (unreadable/undownloadable CSV, parse error,
 * write error) is caught per-iteration and recorded as that period's
 * `error`; the loop always continues to the remaining reports so one bad
 * file never aborts the run. This tool is invoked by a human via the route
 * below -- it never runs unattended.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseGustoPayrollJournal, computeGlBucketTotals, computeExpectedDebits, type GlBucketTotal } from "./gustoParser";
import { recomputePeriodExpenseSplits } from "@/lib/finance/payrollMatching";

const BUCKET = "payroll-gl-reports";

export interface BackfillBucketSummary {
  wagesCents: number;
  employerTaxCents: number;
  tipsCents: number;
}

/** A GL account the fresh parse produces that the stored totals never had. */
export interface RecoveredAccount {
  chartOfAccountsId: string;
  amountCents: number;
}

export interface BackfillPeriodResult {
  payPeriodId: string;
  reportId: string;
  before: BackfillBucketSummary;
  after: BackfillBucketSummary;
  /**
   * Wage accounts present in the re-parse but ABSENT from the stored totals —
   * i.e. wages the original upload silently dropped.
   *
   * `computeGlBucketTotals` skips an employee's gross when their department has
   * no mapping (it records the name in `unmappedDepartments` and moves on),
   * while still accruing their employer tax. So a report uploaded before its
   * department was mapped is permanently short those wages.
   *
   * That is not hypothetical: the 2026-05-04 and 2026-05-18 reports were
   * uploaded at 00:53:58 and 00:55:37 on 2026-07-17, and the "Sales & Admin"
   * mapping was created at 00:56:01 — two minutes and twenty-four seconds
   * later. Both periods are missing that employee's wages ($350.60 and $400.00)
   * to this day.
   *
   * The backfill CORRECTS that, which means non-tip payroll legitimately rises.
   * Reporting the accounts responsible lets the UI distinguish "recovered wages
   * the upload dropped" from "the re-parse invented money" instead of blocking
   * both alike. Inferred from the data — an account in the new buckets with no
   * stored row — rather than from any record of past mapping state, which is
   * not kept.
   */
  recoveredAccounts: RecoveredAccount[];
  /**
   * The two ACH pulls this report says to expect, re-derived from the stored
   * CSV. Reported on dry runs too, so the amounts can be eyeballed against the
   * period's actual bank charges BEFORE anything is written — which is the
   * whole review this tool's human gate exists for.
   */
  expectedDebits: { netPayCents: number; taxCents: number; reimbursementsCents: number };
  splitsRecomputed: boolean;
  error?: string;
}

function emptySummary(): BackfillBucketSummary {
  return { wagesCents: 0, employerTaxCents: 0, tipsCents: 0 };
}

function summarizeRows(rows: { bucket_kind: string | null; amount_cents: number }[]): BackfillBucketSummary {
  const summary = emptySummary();
  for (const row of rows) {
    if (row.bucket_kind === "wages") summary.wagesCents += row.amount_cents;
    else if (row.bucket_kind === "employer_tax") summary.employerTaxCents += row.amount_cents;
    else if (row.bucket_kind === "tips") summary.tipsCents += row.amount_cents;
    // null/unrecognised bucket_kind (pre-backfill rows) is never counted --
    // that absence is exactly what the backfill exists to fix.
  }
  return summary;
}

/**
 * Wage accounts in the fresh parse that have no stored row at all. Restricted
 * to `wages` buckets: employer tax and tips are company-wide single buckets
 * accrued regardless of department mapping, so their appearance is expected and
 * carries no information about dropped wages.
 */
function findRecoveredAccounts(
  buckets: GlBucketTotal[],
  existingRows: { chart_of_accounts_id: string }[],
): RecoveredAccount[] {
  const stored = new Set(existingRows.map((r) => r.chart_of_accounts_id));
  return buckets
    .filter((b) => b.kind === "wages" && !stored.has(b.chartOfAccountsId))
    .map((b) => ({ chartOfAccountsId: b.chartOfAccountsId, amountCents: b.amountCents }));
}

function summarizeBuckets(buckets: GlBucketTotal[]): BackfillBucketSummary {
  const summary = emptySummary();
  for (const bucket of buckets) {
    if (bucket.kind === "wages") summary.wagesCents += bucket.amountCents;
    else if (bucket.kind === "employer_tax") summary.employerTaxCents += bucket.amountCents;
    else if (bucket.kind === "tips") summary.tipsCents += bucket.amountCents;
  }
  return summary;
}

/**
 * Re-parses every active (non-superseded) payroll_gl_reports row's stored
 * CSV and returns a per-period before/after bucket contrast. See the
 * file-level doc comment for the dry-run write guarantee and per-report
 * failure isolation.
 */
export async function backfillGlReports(
  sb: SupabaseClient,
  opts: { dryRun: boolean },
): Promise<BackfillPeriodResult[]> {
  const [reportsResult, mappingsResult, settingsResult] = await Promise.all([
    sb.from("payroll_gl_reports").select("id, pay_period_id, storage_path").is("superseded_at", null),
    sb.from("payroll_department_gl_mappings").select("department_name, chart_of_accounts_id"),
    sb.from("payroll_gl_settings").select("payroll_taxes_chart_of_accounts_id, tips_chart_of_accounts_id").single(),
  ]);
  if (reportsResult.error) throw new Error(`Load payroll GL reports failed: ${reportsResult.error.message}`);
  if (mappingsResult.error) throw new Error(`Load department mappings failed: ${mappingsResult.error.message}`);
  if (settingsResult.error) throw new Error(`Load payroll GL settings failed: ${settingsResult.error.message}`);

  const reports = (reportsResult.data ?? []) as { id: string; pay_period_id: string; storage_path: string }[];
  const departmentMap = new Map<string, string>(
    ((mappingsResult.data ?? []) as { department_name: string; chart_of_accounts_id: string }[]).map((row) => [
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
      "No tips account configured — set one in Finance → Settings → Payroll Departments before running the backfill.",
    );
  }

  const results: BackfillPeriodResult[] = [];

  for (const report of reports) {
    try {
      const { data: totalRows, error: totalsErr } = await sb
        .from("payroll_gl_report_totals")
        .select("chart_of_accounts_id, bucket_kind, amount_cents")
        .eq("report_id", report.id);
      if (totalsErr) throw new Error(`Load existing totals failed: ${totalsErr.message}`);
      // Retained verbatim so a failed insert (after the delete below already
      // succeeded) can be undone by re-inserting exactly what was there.
      const existingRows = (totalRows ?? []) as {
        chart_of_accounts_id: string;
        bucket_kind: string | null;
        amount_cents: number;
      }[];
      const before = summarizeRows(existingRows);

      const { data: fileData, error: downloadErr } = await sb.storage.from(BUCKET).download(report.storage_path);
      if (downloadErr) throw new Error(`Download CSV failed: ${downloadErr.message}`);
      if (!fileData) throw new Error("Download CSV failed: no data returned");
      const csvText = await (fileData as Blob).text();

      const parsed = parseGustoPayrollJournal(csvText);
      const buckets = computeGlBucketTotals(parsed, departmentMap, payrollTaxesAccountId, tipsAccountId);
      const after = summarizeBuckets(buckets);
      const recoveredAccounts = findRecoveredAccounts(buckets, existingRows);
      // The same download and parse already needed for the buckets also yields
      // what the report says will LEAVE THE BANK -- the two ACH pulls amount
      // matching needs (gustoParser's ExpectedDebits). Reports uploaded before
      // those columns were parsed have NULLs, and a NULL makes
      // matchPeriodByExpectedDebits skip the period entirely, so this is how a
      // historical period becomes matchable at all.
      const expectedDebits = computeExpectedDebits(parsed);

      let splitsRecomputed = false;
      if (!opts.dryRun) {
        const { error: debitsErr } = await sb
          .from("payroll_gl_reports")
          .update({
            expected_net_pay_cents: expectedDebits.netPayCents,
            expected_tax_cents: expectedDebits.taxCents,
            expected_reimbursements_cents: expectedDebits.reimbursementsCents,
          })
          .eq("id", report.id);
        if (debitsErr) throw new Error(`Update expected debits failed: ${debitsErr.message}`);

        const { error: deleteErr } = await sb.from("payroll_gl_report_totals").delete().eq("report_id", report.id);
        if (deleteErr) throw new Error(`Delete existing totals failed: ${deleteErr.message}`);

        if (buckets.length > 0) {
          const { error: insertErr } = await sb.from("payroll_gl_report_totals").insert(
            buckets.map((bucket) => ({
              report_id: report.id,
              chart_of_accounts_id: bucket.chartOfAccountsId,
              amount_cents: bucket.amountCents,
              bucket_kind: bucket.kind,
            })),
          );
          if (insertErr) {
            // The delete above already succeeded, so without a restore this
            // period would be left with ZERO payroll_gl_report_totals rows --
            // recomputePeriodExpenseSplits would then see empty totals,
            // delete the existing payroll_auto splits, and insert nothing,
            // silently falling every matched expense to unmapped. Put the
            // rows read before the delete back so the period isn't destroyed.
            let restoreNote = "";
            if (existingRows.length > 0) {
              const { error: restoreErr } = await sb.from("payroll_gl_report_totals").insert(
                existingRows.map((row) => ({
                  report_id: report.id,
                  chart_of_accounts_id: row.chart_of_accounts_id,
                  amount_cents: row.amount_cents,
                  bucket_kind: row.bucket_kind,
                })),
              );
              if (restoreErr) {
                restoreNote = ` Restore of the original rows ALSO failed (${restoreErr.message}) -- this period needs manual recovery from backup.`;
              }
            }
            throw new Error(`Insert new totals failed: ${insertErr.message}.${restoreNote}`);
          }
        }

        await recomputePeriodExpenseSplits(sb, report.pay_period_id);
        splitsRecomputed = true;
      }

      results.push({
        payPeriodId: report.pay_period_id,
        reportId: report.id,
        before,
        after,
        recoveredAccounts,
        expectedDebits,
        splitsRecomputed,
      });
    } catch (err) {
      results.push({
        payPeriodId: report.pay_period_id,
        reportId: report.id,
        before: emptySummary(),
        after: emptySummary(),
        recoveredAccounts: [],
        expectedDebits: { netPayCents: 0, taxCents: 0, reimbursementsCents: 0 },
        splitsRecomputed: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

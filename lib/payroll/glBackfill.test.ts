import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { backfillGlReports } from "./glBackfill";

// Vitest hoists `vi.mock` above imports and special-cases `mock`-prefixed
// top-level consts referenced inside the factory -- same convention as
// app/api/finance/payroll-periods/[periodId]/recompute-splits/route.test.ts.
const mockRecompute = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/finance/payrollMatching", () => ({
  recomputePeriodExpenseSplits: (...args: unknown[]) => mockRecompute(...args),
}));

const PRODUCTION_COA_ID = "coa-production";
const TAXES_COA_ID = "coa-payroll-taxes";
const TIPS_COA_ID = "coa-payroll-tips";

// Two employees so wages sum > 0, one with Paycheck Tips so the tips bucket
// is non-zero -- exercises all three bucket kinds in computeGlBucketTotals.
const CSV_WITH_TIPS = `"Payroll period"," 06/15/2026 - 06/28/2026"
"Pay day"," 07/01/2026"
"Last Name","First Name","Department","Work Address","Employee Type","Payment","Job","Pay Type","Hours","Rate","Amount","Employee Taxes","Federal Income Tax (Employee)","Social Security (Employee)","Medicare (Employee)","Additional Medicare (Employee)","NC State Tax (Employee)","Employer Taxes","Social Security (Employer)","Medicare (Employer)","FUTA (Employer)","NC Unemployment Tax (Employer)","Net Pay","Reimbursements","Donations","Check Amount","Employer Cost"
"Ashford","Casey","Production","addr","Salary/No overtime","Direct Deposit","Brewer","Regular","80.00","29.81","1000.00","0","0","0","0","0","0","100.00","0","0","0","0","0","0","0","0","0"
"","","","","","","Totals","Paycheck Tips","","","50.00","0","0","0","0","0","0","0","0","0","0","0","0","0","0","0"
`;

function makeReportRow(overrides: Partial<{ id: string; pay_period_id: string; storage_path: string }> = {}) {
  return {
    id: "R1",
    pay_period_id: "P1",
    storage_path: "P1/uuid-payroll.csv",
    ...overrides,
  };
}

function makeSb(opts: {
  reportRows?: { id: string; pay_period_id: string; storage_path: string }[];
  reportsError?: { message: string } | null;
  mappingRows?: { department_name: string; chart_of_accounts_id: string }[];
  settingsRow?: { payroll_taxes_chart_of_accounts_id: string; tips_chart_of_accounts_id: string | null } | null;
  existingTotalsByReport?: Record<
    string,
    { chart_of_accounts_id?: string; bucket_kind: string | null; amount_cents: number }[]
  >;
  downloadTextByReport?: Record<string, string>;
  downloadErrorByReport?: Record<string, { message: string }>;
  deleteError?: { message: string } | null;
  /** Fails the first `payroll_gl_report_totals` insert call only (the primary
   *  write); subsequent calls (e.g. the post-failure restore) succeed. */
  insertError?: { message: string } | null;
  /** Fails every `payroll_gl_report_totals` insert call, including a restore
   *  attempt -- simulates the restore itself also failing. */
  insertErrorAlways?: boolean;
} = {}) {
  const calls: { kind: string; args: unknown[] }[] = [];
  let insertCallCount = 0;

  const storageFrom = vi.fn((bucket: string) => {
    calls.push({ kind: "storage.from", args: [bucket] });
    return {
      download: vi.fn(async (path: string) => {
        calls.push({ kind: "storage.download", args: [path] });
        const reportId = (opts.reportRows ?? [makeReportRow()]).find((r) => r.storage_path === path)?.id ?? "R1";
        if (opts.downloadErrorByReport?.[reportId]) {
          return { data: null, error: opts.downloadErrorByReport[reportId] };
        }
        const text = opts.downloadTextByReport?.[reportId] ?? CSV_WITH_TIPS;
        return { data: { text: async () => text } as unknown as Blob, error: null };
      }),
    };
  });

  const tableFrom = vi.fn((table: string) => {
    calls.push({ kind: "from", args: [table] });

    if (table === "payroll_gl_reports") {
      return {
        select: (cols: string) => {
          calls.push({ kind: "select", args: [table, cols] });
          const builder = {
            is: (col: string, val: unknown) => {
              calls.push({ kind: "is", args: [col, val] });
              return Promise.resolve(
                opts.reportsError
                  ? { data: null, error: opts.reportsError }
                  : { data: opts.reportRows ?? [makeReportRow()], error: null },
              );
            },
          };
          return builder;
        },
      };
    }

    if (table === "payroll_gl_report_totals") {
      return {
        select: (cols: string) => {
          calls.push({ kind: "select", args: [table, cols] });
          const builder = {
            eq: async (col: string, val: unknown) => {
              calls.push({ kind: "eq", args: [col, val] });
              return { data: opts.existingTotalsByReport?.[val as string] ?? [], error: null };
            },
          };
          return builder;
        },
        delete: () => {
          calls.push({ kind: "delete", args: [table] });
          const builder = {
            eq: async (col: string, val: unknown) => {
              calls.push({ kind: "eq", args: [col, val] });
              return opts.deleteError ? { data: null, error: opts.deleteError } : { data: null, error: null };
            },
          };
          return builder;
        },
        insert: (payload: unknown) => {
          insertCallCount++;
          calls.push({ kind: "insert", args: [table, payload] });
          const shouldFail = opts.insertError && (opts.insertErrorAlways || insertCallCount === 1);
          return Promise.resolve(shouldFail ? { data: null, error: opts.insertError } : { data: null, error: null });
        },
      };
    }

    if (table === "payroll_department_gl_mappings") {
      return {
        select: (cols: string) => {
          calls.push({ kind: "select", args: [table, cols] });
          return Promise.resolve({ data: opts.mappingRows ?? [{ department_name: "Production", chart_of_accounts_id: PRODUCTION_COA_ID }], error: null });
        },
      };
    }

    if (table === "payroll_gl_settings") {
      return {
        select: (cols: string) => {
          calls.push({ kind: "select", args: [table, cols] });
          return {
            single: async () => ({
              data: opts.settingsRow ?? {
                payroll_taxes_chart_of_accounts_id: TAXES_COA_ID,
                tips_chart_of_accounts_id: TIPS_COA_ID,
              },
              error: null,
            }),
          };
        },
      };
    }

    throw new Error(`Unexpected table in stub: ${table}`);
  });

  const sb = { storage: { from: storageFrom }, from: tableFrom } as unknown as SupabaseClient;
  return { sb, calls };
}

describe("backfillGlReports", () => {
  it("dryRun: true performs zero writes and returns populated before/after", async () => {
    const { sb, calls } = makeSb({
      existingTotalsByReport: { R1: [{ bucket_kind: "wages", amount_cents: 900 }] },
    });

    const results = await backfillGlReports(sb, { dryRun: true });

    expect(results).toHaveLength(1);
    expect(results[0].error).toBeUndefined();
    expect(results[0].before).toEqual({ wagesCents: 900, employerTaxCents: 0, tipsCents: 0 });
    expect(results[0].after).toEqual({ wagesCents: 100000, employerTaxCents: 10000, tipsCents: 5000 });
    expect(results[0].splitsRecomputed).toBe(false);

    // No write verbs were ever invoked on the mocked client.
    expect(calls.some((c) => c.kind === "delete")).toBe(false);
    expect(calls.some((c) => c.kind === "insert")).toBe(false);
    expect(mockRecompute).not.toHaveBeenCalled();
  });

  it("dryRun: false replaces totals and calls recomputePeriodExpenseSplits once per period", async () => {
    mockRecompute.mockClear();
    const { sb, calls } = makeSb({
      existingTotalsByReport: { R1: [{ bucket_kind: "wages", amount_cents: 900 }] },
    });

    const results = await backfillGlReports(sb, { dryRun: false });

    expect(results[0].error).toBeUndefined();
    expect(results[0].splitsRecomputed).toBe(true);

    const deleteCall = calls.find((c) => c.kind === "delete");
    expect(deleteCall).toBeTruthy();
    const insertCall = calls.find((c) => c.kind === "insert");
    expect(insertCall).toBeTruthy();
    const insertPayload = (insertCall!.args[1] as { bucket_kind: string; amount_cents: number }[]);
    expect(insertPayload.map((r) => r.bucket_kind).sort()).toEqual(["employer_tax", "tips", "wages"]);

    expect(mockRecompute).toHaveBeenCalledTimes(1);
    expect(mockRecompute).toHaveBeenCalledWith(sb, "P1");
  });

  it("skips superseded reports (not returned by the query at all)", async () => {
    // The query itself filters superseded_at IS NULL -- simulate a store with
    // only the active report returned, proving no superseded row is processed.
    const { sb } = makeSb({ reportRows: [makeReportRow({ id: "R-active", storage_path: "P1/active.csv" })] });

    const results = await backfillGlReports(sb, { dryRun: true });

    expect(results).toHaveLength(1);
    expect(results[0].reportId).toBe("R-active");
  });

  it("records an error and continues when a report's CSV download fails", async () => {
    mockRecompute.mockClear();
    const { sb } = makeSb({
      reportRows: [
        makeReportRow({ id: "R-bad", pay_period_id: "P-bad", storage_path: "P-bad/broken.csv" }),
        makeReportRow({ id: "R-good", pay_period_id: "P-good", storage_path: "P-good/ok.csv" }),
      ],
      downloadErrorByReport: { "R-bad": { message: "object not found" } },
      downloadTextByReport: { "R-good": CSV_WITH_TIPS },
    });

    const results = await backfillGlReports(sb, { dryRun: true });

    expect(results).toHaveLength(2);
    const bad = results.find((r) => r.reportId === "R-bad")!;
    const good = results.find((r) => r.reportId === "R-good")!;
    expect(bad.error).toMatch(/object not found/);
    expect(good.error).toBeUndefined();
    expect(good.after).toEqual({ wagesCents: 100000, employerTaxCents: 10000, tipsCents: 5000 });
  });

  it("buckets before/after summaries by kind correctly", async () => {
    const { sb } = makeSb({
      existingTotalsByReport: {
        R1: [
          { bucket_kind: "wages", amount_cents: 500 },
          { bucket_kind: "wages", amount_cents: 400 },
          { bucket_kind: "employer_tax", amount_cents: 60 },
          { bucket_kind: null, amount_cents: 999 }, // pre-backfill row with no bucket_kind -- ignored, never miscounted
        ],
      },
    });

    const results = await backfillGlReports(sb, { dryRun: true });

    expect(results[0].before).toEqual({ wagesCents: 900, employerTaxCents: 60, tipsCents: 0 });
    expect(results[0].after).toEqual({ wagesCents: 100000, employerTaxCents: 10000, tipsCents: 5000 });
  });

  // A report uploaded before its department was mapped is permanently short
  // that department's wages -- computeGlBucketTotals skips an unmapped
  // employee's gross while still accruing their employer tax. Re-parsing with
  // the mapping in place restores them, so non-tip payroll legitimately rises.
  // Reporting WHICH accounts came back is what lets the UI tell that apart from
  // the re-parse inventing money. Real case: the 2026-05-04 and 2026-05-18
  // reports were uploaded ~2 minutes before the "Sales & Admin" mapping existed.
  it("reports a wage account absent from the stored totals as recovered", async () => {
    const { sb } = makeSb({
      existingTotalsByReport: {
        // Employer tax was recorded, but the Production wages row never was.
        R1: [{ chart_of_accounts_id: TAXES_COA_ID, bucket_kind: "employer_tax", amount_cents: 10000 }],
      },
    });

    const results = await backfillGlReports(sb, { dryRun: true });

    expect(results[0].recoveredAccounts).toEqual([
      { chartOfAccountsId: PRODUCTION_COA_ID, amountCents: 100000 },
    ]);
  });

  it("reports nothing recovered when every wage account already has a stored row", async () => {
    const { sb } = makeSb({
      existingTotalsByReport: {
        R1: [
          { chart_of_accounts_id: PRODUCTION_COA_ID, bucket_kind: "wages", amount_cents: 100000 },
          { chart_of_accounts_id: TAXES_COA_ID, bucket_kind: "employer_tax", amount_cents: 10000 },
        ],
      },
    });

    const results = await backfillGlReports(sb, { dryRun: true });

    expect(results[0].recoveredAccounts).toEqual([]);
  });

  // Employer tax and tips are company-wide buckets accrued regardless of
  // department mapping, so their appearance says nothing about dropped wages
  // and must never be reported as recovered -- otherwise EVERY period would
  // look "explained" purely because the tips bucket is new.
  it("never reports the tips or employer-tax buckets as recovered", async () => {
    const { sb } = makeSb({
      existingTotalsByReport: {
        R1: [{ chart_of_accounts_id: PRODUCTION_COA_ID, bucket_kind: "wages", amount_cents: 100000 }],
      },
    });

    const results = await backfillGlReports(sb, { dryRun: true });

    expect(results[0].after.tipsCents).toBe(5000);
    expect(results[0].recoveredAccounts).toEqual([]);
  });

  it("restores the original rows when the insert fails after delete succeeds", async () => {
    mockRecompute.mockClear();
    const originalRows = [{ chart_of_accounts_id: PRODUCTION_COA_ID, bucket_kind: "wages", amount_cents: 900 }];
    const { sb, calls } = makeSb({
      existingTotalsByReport: { R1: originalRows },
      insertError: { message: "insert failed" },
    });

    const results = await backfillGlReports(sb, { dryRun: false });

    expect(results).toHaveLength(1);
    expect(results[0].error).toMatch(/Insert new totals failed: insert failed/);
    expect(results[0].splitsRecomputed).toBe(false);
    expect(mockRecompute).not.toHaveBeenCalled();

    // Delete happened, then two inserts: the failed primary write and the
    // restore of the pre-delete rows.
    expect(calls.some((c) => c.kind === "delete")).toBe(true);
    const insertCalls = calls.filter((c) => c.kind === "insert");
    expect(insertCalls).toHaveLength(2);
    const restorePayload = insertCalls[1].args[1] as {
      report_id: string;
      chart_of_accounts_id: string;
      amount_cents: number;
      bucket_kind: string | null;
    }[];
    expect(restorePayload).toEqual([
      { report_id: "R1", chart_of_accounts_id: PRODUCTION_COA_ID, amount_cents: 900, bucket_kind: "wages" },
    ]);
  });

  it("records manual-recovery guidance when the restore insert also fails", async () => {
    mockRecompute.mockClear();
    const originalRows = [{ chart_of_accounts_id: PRODUCTION_COA_ID, bucket_kind: "wages", amount_cents: 900 }];
    const { sb } = makeSb({
      existingTotalsByReport: { R1: originalRows },
      insertError: { message: "insert failed" },
      insertErrorAlways: true,
    });

    const results = await backfillGlReports(sb, { dryRun: false });

    expect(results[0].error).toMatch(/Insert new totals failed: insert failed/);
    expect(results[0].error).toMatch(/Restore of the original rows ALSO failed/);
    expect(results[0].error).toMatch(/manual recovery/i);
    expect(mockRecompute).not.toHaveBeenCalled();
  });
});

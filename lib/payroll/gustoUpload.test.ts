import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PayrollGlReport, PayrollGlReportTotal } from "./types";
import { uploadGustoReport, getActiveGustoReport } from "./gustoUpload";

// Stubbed sb whose `.storage.from(bucket)` returns an upload mock and whose
// `.from(table)` returns table-shaped query builders — same hand-rolled
// convention as lib/tax/files.test.ts (no real DB, no real Storage).

const PRODUCTION_COA_ID = "coa-production";
const FOH_COA_ID = "coa-foh";
const TAXES_COA_ID = "coa-payroll-taxes";
const TIPS_COA_ID = "coa-payroll-tips";

const sampleReport: PayrollGlReport = {
  id: "R1",
  pay_period_id: "P1",
  storage_path: "P1/uuid-payroll.csv",
  original_filename: "payroll.csv",
  uploaded_at: "2026-07-15T00:00:00Z",
  uploaded_by: "USER_1",
  superseded_at: null,
};

const sampleTotals: PayrollGlReportTotal[] = [
  { id: "T1", report_id: "R1", chart_of_accounts_id: PRODUCTION_COA_ID, amount_cents: 1000, bucket_kind: "wages" },
  { id: "T2", report_id: "R1", chart_of_accounts_id: TAXES_COA_ID, amount_cents: 100, bucket_kind: "employer_tax" },
];

// A minimal single-employee CSV — just enough to exercise the upload/parse/
// persist pipeline; exact parsing rules are covered by gustoParser.test.ts.
const MINIMAL_CSV = `"Payroll period"," 06/15/2026 - 06/28/2026"
"Pay day"," 07/01/2026"
"Last Name","First Name","Department","Work Address","Employee Type","Payment","Job","Pay Type","Hours","Rate","Amount","Employee Taxes","Federal Income Tax (Employee)","Social Security (Employee)","Medicare (Employee)","Additional Medicare (Employee)","NC State Tax (Employee)","Employer Taxes","Social Security (Employer)","Medicare (Employer)","FUTA (Employer)","NC Unemployment Tax (Employer)","Net Pay","Reimbursements","Donations","Check Amount","Employer Cost"
"Ashford","Casey","Production","addr","Salary/No overtime","Direct Deposit","Brewer","Regular","80.00","29.81","100.00","0","0","0","0","0","0","10.00","0","0","0","0","0","0","0","0","0"
`;

function makeSb(opts: {
  uploadError?: { message: string } | null;
  supersedeError?: { message: string } | null;
  mappingRows?: { department_name: string; chart_of_accounts_id: string }[];
  mappingError?: { message: string } | null;
  settingsRow?: { payroll_taxes_chart_of_accounts_id: string; tips_chart_of_accounts_id: string | null } | null;
  settingsError?: { message: string } | null;
  reportInsertResult?: { data: unknown; error: unknown };
  employeesInsertError?: { message: string } | null;
  totalsInsertResult?: { data: unknown; error: unknown };
  activeReportResult?: { data: unknown; error: unknown };
  totalsSelectResult?: { data: unknown; error: unknown };
  employeeDepartmentsResult?: { data: unknown; error: unknown };
  reportDeleteError?: { message: string } | null;
  employeesDeleteError?: { message: string } | null;
} = {}) {
  const calls: { kind: string; args: unknown[] }[] = [];

  const storageFrom = vi.fn((bucket: string) => {
    calls.push({ kind: "storage.from", args: [bucket] });
    return {
      upload: vi.fn(async (path: string, file: unknown) => {
        calls.push({ kind: "storage.upload", args: [path, file] });
        if (opts.uploadError) return { data: null, error: opts.uploadError };
        return { data: { path }, error: null };
      }),
    };
  });

  const tableFrom = vi.fn((table: string) => {
    calls.push({ kind: "from", args: [table] });

    if (table === "payroll_gl_reports") {
      return {
        update: (payload: unknown) => {
          calls.push({ kind: "update", args: [payload] });
          const builder = {
            eq: (col: string, val: unknown) => {
              calls.push({ kind: "eq", args: [col, val] });
              return builder;
            },
            is: (col: string, val: unknown) => {
              calls.push({ kind: "is", args: [col, val] });
              return builder;
            },
            neq: (col: string, val: unknown) => {
              calls.push({ kind: "neq", args: [col, val] });
              return Promise.resolve(
                opts.supersedeError ? { data: null, error: opts.supersedeError } : { data: null, error: null }
              );
            },
          };
          return builder;
        },
        insert: (payload: unknown) => {
          calls.push({ kind: "insert", args: [payload] });
          return {
            select: () => ({
              single: async () => opts.reportInsertResult ?? { data: sampleReport, error: null },
            }),
          };
        },
        select: (cols: string) => {
          calls.push({ kind: "select", args: [cols] });
          const builder = {
            eq: (col: string, val: unknown) => {
              calls.push({ kind: "eq", args: [col, val] });
              return builder;
            },
            is: (col: string, val: unknown) => {
              calls.push({ kind: "is", args: [col, val] });
              return builder;
            },
            order: (col: string, orderOpts: unknown) => {
              calls.push({ kind: "order", args: [col, orderOpts] });
              return builder;
            },
            limit: (n: number) => {
              calls.push({ kind: "limit", args: [n] });
              return builder;
            },
            maybeSingle: async () => opts.activeReportResult ?? { data: sampleReport, error: null },
          };
          return builder;
        },
        delete: () => {
          calls.push({ kind: "delete", args: [] });
          const builder = {
            eq: async (col: string, val: unknown) => {
              calls.push({ kind: "eq", args: [col, val] });
              return opts.reportDeleteError ? { data: null, error: opts.reportDeleteError } : { data: null, error: null };
            },
          };
          return builder;
        },
      };
    }

    if (table === "payroll_gl_report_employees") {
      return {
        insert: (payload: unknown) => {
          calls.push({ kind: "insert", args: [payload] });
          return Promise.resolve(
            opts.employeesInsertError ? { data: null, error: opts.employeesInsertError } : { data: null, error: null }
          );
        },
        select: (cols: string) => {
          calls.push({ kind: "select", args: [cols] });
          const builder = {
            eq: (col: string, val: unknown) => {
              calls.push({ kind: "eq", args: [col, val] });
              return Promise.resolve(opts.employeeDepartmentsResult ?? { data: [], error: null });
            },
          };
          return builder;
        },
        delete: () => {
          calls.push({ kind: "delete", args: [] });
          const builder = {
            eq: async (col: string, val: unknown) => {
              calls.push({ kind: "eq", args: [col, val] });
              return opts.employeesDeleteError
                ? { data: null, error: opts.employeesDeleteError }
                : { data: null, error: null };
            },
          };
          return builder;
        },
      };
    }

    if (table === "payroll_gl_report_totals") {
      return {
        insert: (payload: unknown) => {
          calls.push({ kind: "insert", args: [payload] });
          return {
            select: async () => opts.totalsInsertResult ?? { data: sampleTotals, error: null },
          };
        },
        select: (cols: string) => {
          calls.push({ kind: "select", args: [cols] });
          const builder = {
            eq: (col: string, val: unknown) => {
              calls.push({ kind: "eq", args: [col, val] });
              return Promise.resolve(opts.totalsSelectResult ?? { data: sampleTotals, error: null });
            },
          };
          return builder;
        },
      };
    }

    if (table === "payroll_department_gl_mappings") {
      return {
        select: (cols: string) => {
          calls.push({ kind: "select", args: [cols] });
          return Promise.resolve(
            opts.mappingError ? { data: null, error: opts.mappingError } : { data: opts.mappingRows ?? [], error: null }
          );
        },
      };
    }

    if (table === "payroll_gl_settings") {
      return {
        select: (cols: string) => {
          calls.push({ kind: "select", args: [cols] });
          return {
            single: async () =>
              opts.settingsError
                ? { data: null, error: opts.settingsError }
                : {
                    data: opts.settingsRow ?? {
                      payroll_taxes_chart_of_accounts_id: TAXES_COA_ID,
                      tips_chart_of_accounts_id: TIPS_COA_ID,
                    },
                    error: null,
                  },
          };
        },
      };
    }

    throw new Error(`Unexpected table in stub: ${table}`);
  });

  const sb = { storage: { from: storageFrom }, from: tableFrom } as unknown as SupabaseClient;
  return { sb, calls };
}

function fullDepartmentMappingRows() {
  return [
    { department_name: "Production", chart_of_accounts_id: PRODUCTION_COA_ID },
    { department_name: "Front of House", chart_of_accounts_id: FOH_COA_ID },
  ];
}

describe("uploadGustoReport", () => {
  it("uploads the file, then persists report -> employees -> totals in that order", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("11111111-1111-1111-1111-111111111111");
    const { sb, calls } = makeSb({ mappingRows: fullDepartmentMappingRows() });

    const result = await uploadGustoReport(sb, {
      payPeriodId: "P1",
      file: new Blob([MINIMAL_CSV]),
      fileName: "payroll.csv",
      userId: "USER_1",
    });

    expect(result.report).toEqual(sampleReport);
    expect(result.totals).toEqual(sampleTotals);
    expect(result.unmappedDepartments).toEqual([]);

    const uploadCall = calls.find((c) => c.kind === "storage.upload");
    expect(uploadCall?.args[0]).toBe("P1/11111111-1111-1111-1111-111111111111-payroll.csv");

    const bucketCall = calls.find((c) => c.kind === "storage.from");
    expect(bucketCall?.args[0]).toBe("payroll-gl-reports");

    const reportInsertIdx = calls.findIndex(
      (c) => c.kind === "insert" && (c.args[0] as { pay_period_id?: string }).pay_period_id === "P1"
    );
    const employeesInsertIdx = calls.findIndex(
      (c) =>
        c.kind === "insert" &&
        Array.isArray(c.args[0]) &&
        (c.args[0] as Record<string, unknown>[]).length > 0 &&
        "last_name" in (c.args[0] as Record<string, unknown>[])[0]
    );
    const totalsInsertIdx = calls.findIndex(
      (c) =>
        c.kind === "insert" &&
        Array.isArray(c.args[0]) &&
        (c.args[0] as Record<string, unknown>[]).length > 0 &&
        "chart_of_accounts_id" in (c.args[0] as Record<string, unknown>[])[0]
    );
    const uploadIdx = calls.findIndex((c) => c.kind === "storage.upload");

    expect(uploadIdx).toBeGreaterThanOrEqual(0);
    expect(reportInsertIdx).toBeGreaterThan(uploadIdx);
    expect(employeesInsertIdx).toBeGreaterThan(reportInsertIdx);
    expect(totalsInsertIdx).toBeGreaterThan(employeesInsertIdx);

    vi.restoreAllMocks();
  });

  it("marks the prior active report superseded only after report -> employees -> totals all succeed", async () => {
    const { sb, calls } = makeSb({ mappingRows: fullDepartmentMappingRows() });

    await uploadGustoReport(sb, {
      payPeriodId: "P1",
      file: new Blob([MINIMAL_CSV]),
      fileName: "payroll.csv",
      userId: "USER_1",
    });

    const reportInsertIdx = calls.findIndex(
      (c) => c.kind === "insert" && (c.args[0] as { pay_period_id?: string }).pay_period_id === "P1"
    );
    const employeesInsertIdx = calls.findIndex(
      (c) =>
        c.kind === "insert" &&
        Array.isArray(c.args[0]) &&
        (c.args[0] as Record<string, unknown>[]).length > 0 &&
        "last_name" in (c.args[0] as Record<string, unknown>[])[0]
    );
    const totalsInsertIdx = calls.findIndex(
      (c) =>
        c.kind === "insert" &&
        Array.isArray(c.args[0]) &&
        (c.args[0] as Record<string, unknown>[]).length > 0 &&
        "chart_of_accounts_id" in (c.args[0] as Record<string, unknown>[])[0]
    );
    const supersedeIdx = calls.findIndex((c) => c.kind === "update");

    expect(reportInsertIdx).toBeGreaterThanOrEqual(0);
    expect(employeesInsertIdx).toBeGreaterThan(reportInsertIdx);
    expect(totalsInsertIdx).toBeGreaterThan(employeesInsertIdx);
    expect(supersedeIdx).toBeGreaterThan(totalsInsertIdx);

    // Supersede filters to only the still-active row for this period,
    // excluding the row it just inserted.
    const eqCall = calls.find((c) => c.kind === "eq" && c.args[0] === "pay_period_id");
    const isCall = calls.find((c) => c.kind === "is" && c.args[0] === "superseded_at");
    const neqCall = calls.find((c) => c.kind === "neq" && c.args[0] === "id");
    expect(eqCall?.args[1]).toBe("P1");
    expect(isCall?.args[1]).toBe(null);
    expect(neqCall?.args[1]).toBe(sampleReport.id);
  });

  it("does not touch the previous active report's superseded_at when the storage upload fails", async () => {
    const { sb, calls } = makeSb({ uploadError: { message: "storage boom" } });

    await expect(
      uploadGustoReport(sb, { payPeriodId: "P1", file: new Blob([MINIMAL_CSV]), fileName: "payroll.csv", userId: "USER_1" })
    ).rejects.toThrow(/storage boom/);

    expect(calls.some((c) => c.kind === "update")).toBe(false);
  });

  it("deletes the just-inserted report row and leaves the prior active report untouched when the employees insert fails", async () => {
    const { sb, calls } = makeSb({
      mappingRows: fullDepartmentMappingRows(),
      employeesInsertError: { message: "employees boom" },
    });

    await expect(
      uploadGustoReport(sb, { payPeriodId: "P1", file: new Blob([MINIMAL_CSV]), fileName: "payroll.csv", userId: "USER_1" })
    ).rejects.toThrow(/employees boom/);

    const reportDeleteEq = calls.find(
      (c, i) => c.kind === "eq" && c.args[0] === "id" && c.args[1] === sampleReport.id && calls[i - 1]?.kind === "delete"
    );
    expect(reportDeleteEq).toBeTruthy();
    expect(calls.some((c) => c.kind === "update")).toBe(false);
  });

  it("deletes both the employee rows and the report row, and leaves the prior active report untouched, when the totals insert fails", async () => {
    const { sb, calls } = makeSb({
      mappingRows: fullDepartmentMappingRows(),
      totalsInsertResult: { data: null, error: { message: "totals boom" } },
    });

    await expect(
      uploadGustoReport(sb, { payPeriodId: "P1", file: new Blob([MINIMAL_CSV]), fileName: "payroll.csv", userId: "USER_1" })
    ).rejects.toThrow(/totals boom/);

    const employeesDeleteEq = calls.find(
      (c, i) =>
        c.kind === "eq" && c.args[0] === "report_id" && c.args[1] === sampleReport.id && calls[i - 1]?.kind === "delete"
    );
    const reportDeleteEq = calls.find(
      (c, i) => c.kind === "eq" && c.args[0] === "id" && c.args[1] === sampleReport.id && calls[i - 1]?.kind === "delete"
    );
    expect(employeesDeleteEq).toBeTruthy();
    expect(reportDeleteEq).toBeTruthy();
    // Employees deleted before the report row (dependent rows first).
    expect(calls.indexOf(employeesDeleteEq!)).toBeLessThan(calls.indexOf(reportDeleteEq!));
    expect(calls.some((c) => c.kind === "update")).toBe(false);
  });

  it("throws when tips_chart_of_accounts_id is null, before any DB write", async () => {
    const { sb, calls } = makeSb({
      mappingRows: fullDepartmentMappingRows(),
      settingsRow: { payroll_taxes_chart_of_accounts_id: TAXES_COA_ID, tips_chart_of_accounts_id: null },
    });

    await expect(
      uploadGustoReport(sb, { payPeriodId: "P1", file: new Blob([MINIMAL_CSV]), fileName: "payroll.csv", userId: "USER_1" })
    ).rejects.toThrow(
      "No tips account configured — set one in Finance → Settings → Payroll Departments before uploading a Gusto report."
    );

    expect(
      calls.some((c) => c.kind === "insert" && (c.args[0] as { pay_period_id?: string })?.pay_period_id === "P1")
    ).toBe(false);
  });

  it("persists bucket_kind on each total row matching the computed bucket's kind", async () => {
    const { sb, calls } = makeSb({ mappingRows: fullDepartmentMappingRows() });

    await uploadGustoReport(sb, {
      payPeriodId: "P1",
      file: new Blob([MINIMAL_CSV]),
      fileName: "payroll.csv",
      userId: "USER_1",
    });

    const totalsInsertCall = calls.find(
      (c) =>
        c.kind === "insert" &&
        Array.isArray(c.args[0]) &&
        (c.args[0] as Record<string, unknown>[]).length > 0 &&
        "chart_of_accounts_id" in (c.args[0] as Record<string, unknown>[])[0]
    );
    const payload = totalsInsertCall?.args[0] as
      | { chart_of_accounts_id: string; bucket_kind: string; amount_cents: number }[]
      | undefined;

    expect(payload).toBeDefined();
    const wagesRow = payload!.find((row) => row.chart_of_accounts_id === PRODUCTION_COA_ID);
    const taxesRow = payload!.find((row) => row.chart_of_accounts_id === TAXES_COA_ID);

    expect(wagesRow?.bucket_kind).toBe("wages");
    expect(taxesRow?.bucket_kind).toBe("employer_tax");
  });

  it("surfaces an unmapped department in the result without throwing", async () => {
    const { sb } = makeSb({
      // Only Production is mapped -- the fixture's Front of House-less
      // single employee is Production, so use a mapping set that omits it
      // to force an unmapped department.
      mappingRows: [{ department_name: "Front of House", chart_of_accounts_id: FOH_COA_ID }],
    });

    const result = await uploadGustoReport(sb, {
      payPeriodId: "P1",
      file: new Blob([MINIMAL_CSV]),
      fileName: "payroll.csv",
      userId: "USER_1",
    });

    expect(result.unmappedDepartments).toEqual(["Production"]);
  });

  it("does not insert a report row when the storage upload fails", async () => {
    const { sb, calls } = makeSb({ uploadError: { message: "storage boom" } });

    await expect(
      uploadGustoReport(sb, { payPeriodId: "P1", file: new Blob([MINIMAL_CSV]), fileName: "payroll.csv", userId: "USER_1" })
    ).rejects.toThrow(/storage boom/);

    expect(calls.some((c) => c.kind === "insert" && (c.args[0] as { pay_period_id?: string })?.pay_period_id === "P1")).toBe(
      false
    );
  });

  it("surfaces both the insert error and the cleanup-delete error when the report delete fails after employees insert fails", async () => {
    const { sb } = makeSb({
      mappingRows: fullDepartmentMappingRows(),
      employeesInsertError: { message: "employees insert boom" },
      reportDeleteError: { message: "report delete boom" },
    });

    await expect(
      uploadGustoReport(sb, { payPeriodId: "P1", file: new Blob([MINIMAL_CSV]), fileName: "payroll.csv", userId: "USER_1" })
    ).rejects.toThrow(/Failed to insert employees.*employees insert boom.*cleanup delete of report.*report delete boom.*orphaned report row may exist/);
  });

  it("surfaces both the insert error and the cleanup-delete error when the employees delete fails after totals insert fails", async () => {
    const { sb } = makeSb({
      mappingRows: fullDepartmentMappingRows(),
      totalsInsertResult: { data: null, error: { message: "totals insert boom" } },
      employeesDeleteError: { message: "employees delete boom" },
    });

    await expect(
      uploadGustoReport(sb, { payPeriodId: "P1", file: new Blob([MINIMAL_CSV]), fileName: "payroll.csv", userId: "USER_1" })
    ).rejects.toThrow(/Failed to insert totals.*totals insert boom.*cleanup delete of employees.*employees delete boom.*orphaned report\/employee rows may exist/);
  });

  it("surfaces both the insert error and the cleanup-delete error when the report delete fails after totals insert fails", async () => {
    const { sb } = makeSb({
      mappingRows: fullDepartmentMappingRows(),
      totalsInsertResult: { data: null, error: { message: "totals insert boom" } },
      reportDeleteError: { message: "report delete boom" },
    });

    await expect(
      uploadGustoReport(sb, { payPeriodId: "P1", file: new Blob([MINIMAL_CSV]), fileName: "payroll.csv", userId: "USER_1" })
    ).rejects.toThrow(/Failed to insert totals.*totals insert boom.*cleanup delete of report.*report delete boom.*orphaned report\/employee rows may exist/);
  });

  it("surfaces all three errors when both deletes fail after totals insert fails", async () => {
    const { sb } = makeSb({
      mappingRows: fullDepartmentMappingRows(),
      totalsInsertResult: { data: null, error: { message: "totals insert boom" } },
      employeesDeleteError: { message: "employees delete boom" },
      reportDeleteError: { message: "report delete boom" },
    });

    await expect(
      uploadGustoReport(sb, { payPeriodId: "P1", file: new Blob([MINIMAL_CSV]), fileName: "payroll.csv", userId: "USER_1" })
    ).rejects.toThrow(
      /Failed to insert totals.*totals insert boom.*cleanup delete of employees.*employees delete boom.*cleanup delete of report.*report delete boom.*orphaned report\/employee rows may exist/
    );
  });
});

describe("getActiveGustoReport", () => {
  it("returns null when there is no active report for the period", async () => {
    const { sb } = makeSb({ activeReportResult: { data: null, error: null } });
    const result = await getActiveGustoReport(sb, "P1");
    expect(result).toBeNull();
  });

  it("returns the active report, its totals, and departments missing from the current mapping", async () => {
    const { sb } = makeSb({
      activeReportResult: { data: sampleReport, error: null },
      totalsSelectResult: { data: sampleTotals, error: null },
      employeeDepartmentsResult: { data: [{ department: "Production" }, { department: "Kitchen" }], error: null },
      mappingRows: [{ department_name: "Production", chart_of_accounts_id: PRODUCTION_COA_ID }],
    });

    const result = await getActiveGustoReport(sb, "P1");

    expect(result?.report).toEqual(sampleReport);
    expect(result?.totals).toEqual(sampleTotals);
    expect(result?.unmappedDepartments).toEqual(["Kitchen"]);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requirePermission: vi.fn().mockResolvedValue(undefined) };
});

type Result = { data: unknown; error: unknown };

function makeChain(result: Result) {
  const chain: Record<string, unknown> = {};
  for (const m of ["eq", "in", "order", "limit", "is", "not", "neq"]) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(async () => result);
  chain.maybeSingle = vi.fn(async () => result);
  chain.then = (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
    Promise.resolve(result).then(resolve, reject);
  return chain;
}

interface SbConfig {
  mappingsSelectResults?: Result[]; // consumed in order across repeated selects (GET once, PUT twice)
  settingsSelectResult?: Result;
  deleteResult?: Result;
  insertResult?: Result;
  upsertResult?: Result;
}

function makeSb(config: SbConfig = {}) {
  const calls: { table: string; op: string; args: unknown[] }[] = [];
  const mappingsQueue = [...(config.mappingsSelectResults ?? [{ data: [], error: null }])];

  const from = vi.fn((table: string) => {
    if (table === "payroll_department_gl_mappings") {
      return {
        select: vi.fn((cols: string) => {
          calls.push({ table, op: "select", args: [cols] });
          const result = mappingsQueue.length > 1 ? mappingsQueue.shift()! : mappingsQueue[0];
          return makeChain(result);
        }),
        delete: vi.fn(() => {
          calls.push({ table, op: "delete", args: [] });
          return makeChain(config.deleteResult ?? { data: null, error: null });
        }),
        insert: vi.fn((payload: unknown) => {
          calls.push({ table, op: "insert", args: [payload] });
          return Promise.resolve(config.insertResult ?? { data: null, error: null });
        }),
      };
    }
    if (table === "payroll_gl_settings") {
      return {
        select: vi.fn((cols: string) => {
          calls.push({ table, op: "select", args: [cols] });
          return makeChain(config.settingsSelectResult ?? { data: null, error: null });
        }),
        upsert: vi.fn((payload: unknown, opts: unknown) => {
          calls.push({ table, op: "upsert", args: [payload, opts] });
          return Promise.resolve(config.upsertResult ?? { data: null, error: null });
        }),
      };
    }
    throw new Error(`Unexpected table in stub: ${table}`);
  });

  return { sb: { from }, calls };
}

let sbConfig: SbConfig = {};
let lastCalls: { table: string; op: string; args: unknown[] }[] = [];

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: vi.fn(() => {
    const { sb, calls } = makeSb(sbConfig);
    lastCalls = calls;
    return sb;
  }),
}));

describe("GET /api/finance/settings/payroll-department-mappings", () => {
  beforeEach(() => {
    sbConfig = {};
    lastCalls = [];
  });

  it("returns current mappings + payroll taxes account setting", async () => {
    sbConfig = {
      mappingsSelectResults: [
        {
          data: [
            { id: "M1", department_name: "Production", chart_of_accounts_id: "COA_PROD", created_at: "t", updated_at: "t" },
            { id: "M2", department_name: "Front of House", chart_of_accounts_id: "COA_FOH", created_at: "t", updated_at: "t" },
          ],
          error: null,
        },
      ],
      settingsSelectResult: { data: { payroll_taxes_chart_of_accounts_id: "COA_TAX" }, error: null },
    };

    const { GET } = await import("./route");
    const res = await GET();
    const json = await res.json();

    expect(json.mappings).toHaveLength(2);
    expect(json.payrollTaxesAccountId).toBe("COA_TAX");
  });

  it("returns null payrollTaxesAccountId when settings row does not exist yet", async () => {
    sbConfig = { settingsSelectResult: { data: null, error: null } };

    const { GET } = await import("./route");
    const res = await GET();
    const json = await res.json();

    expect(json.mappings).toEqual([]);
    expect(json.payrollTaxesAccountId).toBeNull();
  });

  it("returns tipsAccountId from the settings row", async () => {
    sbConfig = {
      settingsSelectResult: {
        data: { payroll_taxes_chart_of_accounts_id: "COA_TAX", tips_chart_of_accounts_id: "COA_TIPS" },
        error: null,
      },
    };

    const { GET } = await import("./route");
    const res = await GET();
    const json = await res.json();

    expect(json.tipsAccountId).toBe("COA_TIPS");
  });

  it("returns null tipsAccountId when the column is null", async () => {
    sbConfig = {
      settingsSelectResult: {
        data: { payroll_taxes_chart_of_accounts_id: "COA_TAX", tips_chart_of_accounts_id: null },
        error: null,
      },
    };

    const { GET } = await import("./route");
    const res = await GET();
    const json = await res.json();

    expect(json.tipsAccountId).toBeNull();
  });
});

describe("PUT /api/finance/settings/payroll-department-mappings", () => {
  beforeEach(() => {
    sbConfig = {};
    lastCalls = [];
  });

  function putRequest(body: unknown) {
    return new NextRequest("http://localhost/api/finance/settings/payroll-department-mappings", {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }

  it("adds a new department mapping", async () => {
    sbConfig = {
      mappingsSelectResults: [
        {
          data: [{ id: "M1", department_name: "Production", chart_of_accounts_id: "COA_PROD", created_at: "t", updated_at: "t" }],
          error: null,
        },
      ],
    };

    const { PUT } = await import("./route");
    const res = await PUT(
      putRequest({
        mappings: [{ departmentName: "Production", chartOfAccountsId: "COA_PROD" }],
        payrollTaxesAccountId: "COA_TAX",
        tipsAccountId: "COA_TIPS",
      }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.mappings).toHaveLength(1);
    const insertCall = lastCalls.find((c) => c.table === "payroll_department_gl_mappings" && c.op === "insert");
    expect(insertCall?.args[0]).toEqual([{ department_name: "Production", chart_of_accounts_id: "COA_PROD" }]);
  });

  it("deletes the full existing set before inserting -- omitting a previously-mapped department removes it", async () => {
    sbConfig = { mappingsSelectResults: [{ data: [], error: null }] };

    const { PUT } = await import("./route");
    await PUT(putRequest({ mappings: [], payrollTaxesAccountId: "COA_TAX", tipsAccountId: "COA_TIPS" }));

    const deleteIdx = lastCalls.findIndex((c) => c.table === "payroll_department_gl_mappings" && c.op === "delete");
    const insertIdx = lastCalls.findIndex((c) => c.table === "payroll_department_gl_mappings" && c.op === "insert");
    expect(deleteIdx).toBeGreaterThanOrEqual(0);
    // No mappings submitted -> no insert call at all.
    expect(insertIdx).toBe(-1);
  });

  it("upserts the singleton payroll_gl_settings row", async () => {
    sbConfig = { mappingsSelectResults: [{ data: [], error: null }] };

    const { PUT } = await import("./route");
    await PUT(putRequest({ mappings: [], payrollTaxesAccountId: "COA_TAX", tipsAccountId: "COA_TIPS" }));

    const upsertCall = lastCalls.find((c) => c.table === "payroll_gl_settings" && c.op === "upsert");
    expect(upsertCall?.args[0]).toEqual({
      id: true,
      payroll_taxes_chart_of_accounts_id: "COA_TAX",
      tips_chart_of_accounts_id: "COA_TIPS",
    });
    expect(upsertCall?.args[1]).toEqual({ onConflict: "id" });
  });

  it("requires payrollTaxesAccountId", async () => {
    const { PUT } = await import("./route");
    const res = await PUT(putRequest({ mappings: [], tipsAccountId: "COA_TIPS" }));
    expect(res.status).toBe(400);
  });

  it("requires tipsAccountId", async () => {
    const { PUT } = await import("./route");
    const res = await PUT(putRequest({ mappings: [], payrollTaxesAccountId: "COA_TAX" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("tipsAccountId required");
  });

  it("persists and echoes back tipsAccountId", async () => {
    sbConfig = { mappingsSelectResults: [{ data: [], error: null }] };

    const { PUT } = await import("./route");
    const res = await PUT(putRequest({ mappings: [], payrollTaxesAccountId: "COA_TAX", tipsAccountId: "COA_TIPS" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.tipsAccountId).toBe("COA_TIPS");
  });
});

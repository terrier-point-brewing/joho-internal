import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({
  requireRole: vi.fn().mockResolvedValue(undefined),
  getSessionUser: vi.fn().mockResolvedValue({ user: { id: "USER_1" }, role: "manager" }),
}));

// Split math/manual-skip is Task 5's concern (fully unit-tested in
// payrollMatching.test.ts) -- this route only orchestrates, so we mock the
// lib boundary and assert the route calls it with the right arguments.
const mockSuggestPayPeriod = vi.fn();
const mockRecompute = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/finance/payrollMatching", () => ({
  suggestPayPeriod: (...args: unknown[]) => mockSuggestPayPeriod(...args),
  recomputePeriodExpenseSplits: (...args: unknown[]) => mockRecompute(...args),
}));

type Result = { data: unknown; error: unknown };

function makeChain(result: Result) {
  const chain: Record<string, unknown> = {};
  for (const m of ["eq", "in", "order", "limit", "is", "neq"]) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn(async () => result);
  chain.maybeSingle = vi.fn(async () => result);
  chain.then = (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
    Promise.resolve(result).then(resolve, reject);
  return chain;
}

interface SbConfig {
  expenseRow?: Result;
  ownMatches?: Result;
  periods?: Result;
  insertMatchResult?: Result;
  existingMatch?: Result;
  splitRows?: Result;
  reportRow?: Result;
}

function makeSb(config: SbConfig = {}) {
  const calls: { table: string; op: string; args: unknown[] }[] = [];

  const from = vi.fn((table: string) => {
    if (table === "expenses") {
      return {
        select: vi.fn((cols: string) => {
          calls.push({ table, op: "select", args: [cols] });
          return makeChain(config.expenseRow ?? { data: null, error: null });
        }),
      };
    }
    if (table === "payroll_period_expense_matches") {
      return {
        select: vi.fn((cols: string) => {
          calls.push({ table, op: "select", args: [cols] });
          const chain = makeChain(config.ownMatches ?? { data: [], error: null });
          chain.maybeSingle = vi.fn(async () => config.existingMatch ?? { data: null, error: null });
          return chain;
        }),
        insert: vi.fn((payload: unknown) => {
          calls.push({ table, op: "insert", args: [payload] });
          return Promise.resolve(config.insertMatchResult ?? { data: null, error: null });
        }),
        delete: vi.fn(() => {
          calls.push({ table, op: "delete", args: [] });
          return makeChain({ data: null, error: null });
        }),
      };
    }
    if (table === "pay_periods") {
      return {
        select: vi.fn((cols: string) => {
          calls.push({ table, op: "select", args: [cols] });
          return makeChain(config.periods ?? { data: [], error: null });
        }),
      };
    }
    if (table === "expense_gl_splits") {
      return {
        select: vi.fn((cols: string) => {
          calls.push({ table, op: "select", args: [cols] });
          return makeChain(config.splitRows ?? { data: [], error: null });
        }),
        delete: vi.fn(() => {
          calls.push({ table, op: "delete", args: [] });
          return makeChain({ data: null, error: null });
        }),
      };
    }
    if (table === "payroll_gl_reports") {
      return {
        select: vi.fn((cols: string) => {
          calls.push({ table, op: "select", args: [cols] });
          return makeChain(config.reportRow ?? { data: null, error: null });
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

function postRequest(body: unknown) {
  return new NextRequest("http://localhost/api/finance/expenses/E1/payroll-match", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/finance/expenses/[id]/payroll-match", () => {
  beforeEach(() => {
    sbConfig = {};
    lastCalls = [];
    mockSuggestPayPeriod.mockReset();
    mockRecompute.mockClear();
  });

  it("suggest: returns the nearest unmatched period within the window", async () => {
    sbConfig = {
      expenseRow: { data: { accounting_date: "2026-07-14", transaction_time: null }, error: null },
      ownMatches: { data: [], error: null },
      periods: {
        data: [
          { id: "P1", end_date: "2026-07-15" },
          { id: "P2", end_date: "2026-08-01" },
        ],
        error: null,
      },
    };
    mockSuggestPayPeriod.mockReturnValue("P1");

    const { POST } = await import("./route");
    const res = await POST(postRequest({ action: "suggest" }), { params: Promise.resolve({ id: "E1" }) });
    const json = await res.json();

    expect(json).toEqual({ suggestedPeriodId: "P1" });
    expect(mockSuggestPayPeriod).toHaveBeenCalledWith({
      expenseDate: "2026-07-14",
      candidatePeriods: [
        { id: "P1", endDate: "2026-07-15" },
        { id: "P2", endDate: "2026-08-01" },
      ],
    });
  });

  it("suggest: returns null when suggestPayPeriod finds nothing in the window", async () => {
    sbConfig = {
      expenseRow: { data: { accounting_date: "2026-07-14", transaction_time: null }, error: null },
      ownMatches: { data: [], error: null },
      periods: { data: [{ id: "P1", end_date: "2026-01-01" }], error: null },
    };
    mockSuggestPayPeriod.mockReturnValue(null);

    const { POST } = await import("./route");
    const res = await POST(postRequest({ action: "suggest" }), { params: Promise.resolve({ id: "E1" }) });
    const json = await res.json();

    expect(json).toEqual({ suggestedPeriodId: null });
  });

  it("suggest: excludes periods this expense is already matched to", async () => {
    sbConfig = {
      expenseRow: { data: { accounting_date: "2026-07-14", transaction_time: null }, error: null },
      ownMatches: { data: [{ pay_period_id: "P2" }], error: null },
      periods: {
        data: [
          { id: "P1", end_date: "2026-07-15" },
          { id: "P2", end_date: "2026-07-16" },
        ],
        error: null,
      },
    };
    mockSuggestPayPeriod.mockReturnValue("P1");

    const { POST } = await import("./route");
    await POST(postRequest({ action: "suggest" }), { params: Promise.resolve({ id: "E1" }) });

    expect(mockSuggestPayPeriod).toHaveBeenCalledWith({
      expenseDate: "2026-07-14",
      candidatePeriods: [{ id: "P1", endDate: "2026-07-15" }],
    });
  });

  it("match: inserts the match row and recomputes the whole period's splits", async () => {
    const { POST } = await import("./route");
    const res = await POST(postRequest({ action: "match", payPeriodId: "P1" }), {
      params: Promise.resolve({ id: "E1" }),
    });

    expect(res.status).toBe(201);
    const insertCall = lastCalls.find((c) => c.table === "payroll_period_expense_matches" && c.op === "insert");
    expect(insertCall?.args[0]).toEqual({ pay_period_id: "P1", expense_id: "E1", matched_by: "USER_1" });
    expect(mockRecompute).toHaveBeenCalledWith(expect.anything(), "P1");
  });

  it("unmatch: deletes the match row and payroll_auto splits, then rebalances the period", async () => {
    sbConfig = { existingMatch: { data: { pay_period_id: "P9" }, error: null } };

    const { POST } = await import("./route");
    const res = await POST(postRequest({ action: "unmatch" }), { params: Promise.resolve({ id: "E1" }) });

    expect(res.status).toBe(200);
    expect(lastCalls.some((c) => c.table === "payroll_period_expense_matches" && c.op === "delete")).toBe(true);
    expect(lastCalls.some((c) => c.table === "expense_gl_splits" && c.op === "delete")).toBe(true);
    expect(mockRecompute).toHaveBeenCalledWith(expect.anything(), "P9");
  });

  it("unmatch: 404s when the expense has no match", async () => {
    sbConfig = { existingMatch: { data: null, error: null } };

    const { POST } = await import("./route");
    const res = await POST(postRequest({ action: "unmatch" }), { params: Promise.resolve({ id: "E1" }) });

    expect(res.status).toBe(404);
    expect(mockRecompute).not.toHaveBeenCalled();
  });

  it("recompute: 409s with manual_override_exists when a manual split row exists and confirmOverwriteManual is not set", async () => {
    sbConfig = { splitRows: { data: [{ split_source: "manual" }], error: null } };

    const { POST } = await import("./route");
    const res = await POST(postRequest({ action: "recompute" }), { params: Promise.resolve({ id: "E1" }) });
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json).toEqual({ error: "manual_override_exists" });
    expect(mockRecompute).not.toHaveBeenCalled();
  });

  it("recompute: succeeds when confirmOverwriteManual is true despite an existing manual row", async () => {
    sbConfig = {
      splitRows: { data: [{ split_source: "manual" }], error: null },
      existingMatch: { data: { pay_period_id: "P5" }, error: null },
    };

    const { POST } = await import("./route");
    const res = await POST(postRequest({ action: "recompute", confirmOverwriteManual: true }), {
      params: Promise.resolve({ id: "E1" }),
    });

    expect(res.status).toBe(200);
    expect(mockRecompute).toHaveBeenCalledWith(expect.anything(), "P5");
  });

  it("recompute: succeeds with no manual rows without needing confirmOverwriteManual", async () => {
    sbConfig = {
      splitRows: { data: [{ split_source: "payroll_auto" }], error: null },
      existingMatch: { data: { pay_period_id: "P5" }, error: null },
    };

    const { POST } = await import("./route");
    const res = await POST(postRequest({ action: "recompute" }), { params: Promise.resolve({ id: "E1" }) });

    expect(res.status).toBe(200);
    expect(mockRecompute).toHaveBeenCalledWith(expect.anything(), "P5");
  });
});

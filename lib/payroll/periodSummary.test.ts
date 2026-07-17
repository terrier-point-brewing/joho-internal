import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computePeriodBasis,
  pickBaseRate,
  withinTolerance,
  deriveSplitStatus,
  getPeriodSummaries,
  type BasisEntry,
} from "./periodSummary";

describe("computePeriodBasis", () => {
  it("returns null when there are no snapshot entries (period not locked)", () => {
    expect(computePeriodBasis([], 700)).toBeNull();
  });

  it("computes wages (base + paycheck tips + bonus) and total comp (+ cash tips)", () => {
    const entries: BasisEntry[] = [
      { hours_worked: 10, paycheck_tips_cents: 500, cash_tips_cents: 100, bonus_cents: 50 },
    ];
    // base = round(10 * 700) = 7000; wages = 7000 + 500 + 50 = 7550; total = 7550 + 100 = 7650
    expect(computePeriodBasis(entries, 700)).toEqual({ wagesCents: 7550, totalCompCents: 7650 });
  });

  it("rounds base pay per entry (mirrors the lock-time per-employee snapshot)", () => {
    const entries: BasisEntry[] = [
      { hours_worked: 1.5, paycheck_tips_cents: 0, cash_tips_cents: 0, bonus_cents: 0 },
      { hours_worked: 1.5, paycheck_tips_cents: 0, cash_tips_cents: 0, bonus_cents: 0 },
    ];
    // per entry: round(1.5 * 101) = round(151.5) = 152; total base = 304
    // (a single round(3.0 * 101) = round(303) = 303 would differ — proving per-entry rounding)
    expect(computePeriodBasis(entries, 101)).toEqual({ wagesCents: 304, totalCompCents: 304 });
  });

  it("treats null money/hours fields as zero", () => {
    const entries: BasisEntry[] = [
      { hours_worked: null, paycheck_tips_cents: null, cash_tips_cents: null, bonus_cents: null },
    ];
    expect(computePeriodBasis(entries, 700)).toEqual({ wagesCents: 0, totalCompCents: 0 });
  });
});

describe("pickBaseRate", () => {
  const configs = [
    { effective_from: "2026-06-28", base_rate_cents: 700 },
    { effective_from: "2026-07-15", base_rate_cents: 800 },
  ];

  it("picks the latest config effective on or before the period start", () => {
    expect(pickBaseRate(configs, "2026-07-01")).toBe(700);
    expect(pickBaseRate(configs, "2026-07-15")).toBe(800);
    expect(pickBaseRate(configs, "2026-08-01")).toBe(800);
  });

  it("falls back to the earliest config when the period predates every config", () => {
    expect(pickBaseRate(configs, "2026-05-01")).toBe(700);
  });

  it("returns 0 when there is no config", () => {
    expect(pickBaseRate([], "2026-07-01")).toBe(0);
  });
});

describe("withinTolerance", () => {
  it("uses the $1 default tolerance inclusively", () => {
    expect(withinTolerance(100)).toBe(true);
    expect(withinTolerance(-100)).toBe(true);
    expect(withinTolerance(101)).toBe(false);
    expect(withinTolerance(-101)).toBe(false);
  });

  it("honors a custom tolerance", () => {
    expect(withinTolerance(250, 300)).toBe(true);
    expect(withinTolerance(250, 200)).toBe(false);
  });
});

describe("deriveSplitStatus", () => {
  it("is 'none' when no expenses are matched", () => {
    expect(deriveSplitStatus([], new Set())).toBe("none");
  });

  it("is 'split' when any matched expense carries split rows", () => {
    expect(deriveSplitStatus(["e1", "e2"], new Set(["e2"]))).toBe("split");
  });

  it("is 'awaiting' when matched but none are split yet", () => {
    expect(deriveSplitStatus(["e1", "e2"], new Set(["e9"]))).toBe("awaiting");
  });
});

/**
 * Thenable query-builder stub: every chain method returns `this`, and awaiting
 * the chain (or `.maybeSingle()`) resolves to `{ data, error }`. `.in()` filters
 * `rows` by `filterKey` so batched joins return only the requested ids.
 */
function makeChain(rows: Record<string, unknown>[], filterKey?: string) {
  let inVals: Set<unknown> | null = null;
  const chain: Record<string, unknown> = {
    select: () => chain,
    order: () => chain,
    is: () => chain,
    eq: () => chain,
    in: (_col: string, vals: unknown[]) => {
      inVals = new Set(vals);
      return chain;
    },
    maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
    then: (resolve: (v: { data: unknown[]; error: null }) => unknown, reject?: (e: unknown) => unknown) => {
      const data = inVals && filterKey ? rows.filter((r) => inVals!.has(r[filterKey])) : rows;
      return Promise.resolve({ data, error: null }).then(resolve, reject);
    },
  };
  return chain;
}

function fakeClient(t: Record<string, Record<string, unknown>[]>): SupabaseClient {
  const filterKeys: Record<string, string> = {
    payroll_gl_report_totals: "report_id",
    expenses: "id",
    expense_gl_splits: "expense_id",
  };
  return {
    from: (table: string) => makeChain(t[table] ?? [], filterKeys[table]),
  } as unknown as SupabaseClient;
}

describe("getPeriodSummaries", () => {
  it("composes basis, Gusto totals (taxes excluded), drift, reconciliation, and split status per period", async () => {
    const summaries = await getPeriodSummaries(
      fakeClient({
        pay_periods: [
          { id: "A", start_date: "2026-06-01", end_date: "2026-06-14", due_date: "2026-06-15", status: "locked", locked_at: null, locked_by: null, created_at: "x" },
          { id: "B", start_date: "2026-06-15", end_date: "2026-06-28", due_date: "2026-06-29", status: "open", locked_at: null, locked_by: null, created_at: "x" },
        ],
        payroll_config: [{ effective_from: "2026-06-01", base_rate_cents: 1000 }],
        payroll_entries: [
          { pay_period_id: "A", hours_worked: 10, paycheck_tips_cents: 500, cash_tips_cents: 100, bonus_cents: 0 },
          { pay_period_id: "A", hours_worked: 5, paycheck_tips_cents: 0, cash_tips_cents: 0, bonus_cents: 200 },
        ],
        payroll_gl_settings: [{ payroll_taxes_chart_of_accounts_id: "coa-tax" }],
        payroll_gl_reports: [{ id: "r1", pay_period_id: "A", uploaded_at: "2026-06-30T00:00:00Z", original_filename: "june.csv" }],
        payroll_gl_report_totals: [
          { report_id: "r1", chart_of_accounts_id: "coa-wage", amount_cents: 15650 },
          { report_id: "r1", chart_of_accounts_id: "coa-tax", amount_cents: 3000 },
        ],
        payroll_period_expense_matches: [
          { pay_period_id: "A", expense_id: "e1" },
          { pay_period_id: "A", expense_id: "e2" },
        ],
        expenses: [
          { id: "e1", amount_cents: -18000 },
          { id: "e2", amount_cents: -700 },
        ],
        expense_gl_splits: [{ expense_id: "e1" }],
      }),
    );

    const a = summaries.find((s) => s.id === "A")!;
    expect(a).toMatchObject({
      entryCount: 2,
      appWagesCents: 15700, // 15000 base + 500 paycheck + 200 bonus
      appBasisCents: 15800, // + 100 cash tips
      gustoTotalCents: 18650, // 15650 + 3000
      gustoWagesCents: 15650, // taxes account excluded
      driftCents: 50, // 15700 − 15650
      matchedCount: 2,
      matchedSumCents: 18700, // |−18000| + |−700|
      reconciliationCents: 50, // 18700 − 18650
      splitStatus: "split",
    });

    const b = summaries.find((s) => s.id === "B")!;
    expect(b).toMatchObject({
      entryCount: 0,
      appBasisCents: null,
      appWagesCents: null,
      gustoTotalCents: null,
      gustoWagesCents: null,
      driftCents: null,
      matchedCount: 0,
      matchedSumCents: 0,
      reconciliationCents: null,
      splitStatus: "none",
    });
  });
});

import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  suggestPayPeriod,
  computeProportionalSplits,
  recomputePeriodExpenseSplits,
  planPayrollMatches,
  type MatchedExpenseAmount,
} from "./payrollMatching";
import { aggregateRows, type CoaRecord, type ExpenseRecord } from "./financials/aggregateRows";

describe("suggestPayPeriod", () => {
  it("picks the closest endDate within the 10-day window", () => {
    const result = suggestPayPeriod({
      expenseDate: "2026-07-15",
      candidatePeriods: [
        { id: "p-far", endDate: "2026-06-01" },
        { id: "p-close", endDate: "2026-07-17" },
        { id: "p-farther", endDate: "2026-07-25" },
      ],
    });
    expect(result).toBe("p-close");
  });

  it("returns null when no candidate is within 10 days", () => {
    const result = suggestPayPeriod({
      expenseDate: "2026-07-15",
      candidatePeriods: [{ id: "p-1", endDate: "2026-08-01" }],
    });
    expect(result).toBeNull();
  });

  it("returns null when there are no candidates", () => {
    expect(suggestPayPeriod({ expenseDate: "2026-07-15", candidatePeriods: [] })).toBeNull();
  });

  it("accepts a candidate exactly at the 10-day boundary", () => {
    const result = suggestPayPeriod({
      expenseDate: "2026-07-15",
      candidatePeriods: [{ id: "p-boundary", endDate: "2026-07-25" }],
    });
    expect(result).toBe("p-boundary");
  });
});

describe("computeProportionalSplits", () => {
  function sumsToExpectedPerExpense(result: Map<string, { amountCents: number }[]>, matched: MatchedExpenseAmount[]) {
    for (const e of matched) {
      const lines = result.get(e.expenseId) ?? [];
      const sum = lines.reduce((s, l) => s + l.amountCents, 0);
      expect(sum).toBe(e.amountCents);
    }
  }

  it("two matched expenses (net pay $6852.05, tax debit $807.49) that exactly reconcile with period totals: per-expense sums exact, combined totals equal period totals, and every expense reflects the SAME bucket ratio (the period's own mix)", () => {
    const matched: MatchedExpenseAmount[] = [
      { expenseId: "exp-net-pay", amountCents: 685205 },
      { expenseId: "exp-tax-debit", amountCents: 80749 },
    ];
    const periodTotals = [
      { chartOfAccountsId: "coa-6110", amountCents: 500000 },
      { chartOfAccountsId: "coa-5130", amountCents: 200000 },
      { chartOfAccountsId: "coa-6130", amountCents: 65954 },
    ];

    const result = computeProportionalSplits(matched, periodTotals);

    expect(result.size).toBe(2);
    sumsToExpectedPerExpense(result, matched);

    // splitSource is always payroll_auto
    for (const lines of result.values()) {
      for (const l of lines) expect(l.splitSource).toBe("payroll_auto");
    }

    // Combined totals across both expenses equal the period totals per bucket
    // (holds here because matched total == period total, i.e. exact reconciliation).
    const combinedByBucket = new Map<string, number>();
    for (const lines of result.values()) {
      for (const l of lines) {
        combinedByBucket.set(l.chartOfAccountsId, (combinedByBucket.get(l.chartOfAccountsId) ?? 0) + l.amountCents);
      }
    }
    for (const b of periodTotals) {
      expect(combinedByBucket.get(b.chartOfAccountsId)).toBe(b.amountCents);
    }

    // Every expense's own lines reflect the SAME bucket ratios as the period
    // itself (coa-6110 is 500000/765954 ~= 65.3% of the period; each expense's
    // coa-6110 line should be that same ~65.3% of its own amountCents).
    const periodTotal = periodTotals.reduce((s, b) => s + b.amountCents, 0);
    for (const e of matched) {
      const lines = result.get(e.expenseId)!;
      for (const b of periodTotals) {
        const expectedRatio = b.amountCents / periodTotal;
        const line = lines.find((l) => l.chartOfAccountsId === b.chartOfAccountsId)!;
        const actualRatio = line.amountCents / e.amountCents;
        expect(Math.abs(actualRatio - expectedRatio)).toBeLessThan(0.001);
      }
    }
  });

  it("single matched expense gets 100% of every bucket", () => {
    const matched: MatchedExpenseAmount[] = [{ expenseId: "exp-1", amountCents: 300000 }];
    const periodTotals = [
      { chartOfAccountsId: "coa-a", amountCents: 200000 },
      { chartOfAccountsId: "coa-b", amountCents: 100000 },
    ];
    const result = computeProportionalSplits(matched, periodTotals);
    const lines = result.get("exp-1")!;
    expect(lines).toEqual([
      { chartOfAccountsId: "coa-a", amountCents: 200000, splitSource: "payroll_auto" },
      { chartOfAccountsId: "coa-b", amountCents: 100000, splitSource: "payroll_auto" },
    ]);
  });

  it("rounding: totals that don't divide evenly (1/3-2/3 split of $100.01) still sum exactly per expense", () => {
    const matched: MatchedExpenseAmount[] = [
      { expenseId: "exp-a", amountCents: 3334 }, // ~1/3
      { expenseId: "exp-b", amountCents: 6667 }, // ~2/3
    ];
    const periodTotals = [{ chartOfAccountsId: "coa-only", amountCents: 10001 }];

    const result = computeProportionalSplits(matched, periodTotals);
    sumsToExpectedPerExpense(result, matched);

    const combined = (result.get("exp-a")![0].amountCents) + (result.get("exp-b")![0].amountCents);
    expect(combined).toBe(10001);
  });

  it("handles many buckets with fractional remainders without drift", () => {
    const matched: MatchedExpenseAmount[] = [
      { expenseId: "exp-1", amountCents: 111 },
      { expenseId: "exp-2", amountCents: 222 },
      { expenseId: "exp-3", amountCents: 333 },
    ];
    const periodTotals = [
      { chartOfAccountsId: "coa-1", amountCents: 100 },
      { chartOfAccountsId: "coa-2", amountCents: 200 },
      { chartOfAccountsId: "coa-3", amountCents: 366 },
    ];
    const result = computeProportionalSplits(matched, periodTotals);
    sumsToExpectedPerExpense(result, matched);
  });

  it("bug-reproduction case, now fixed: a single matched expense's amountCents does NOT equal sum(periodTotals) -- its lines must still sum to its OWN amount, not the period total", () => {
    const matched: MatchedExpenseAmount[] = [{ expenseId: "exp-underpaid", amountCents: 1000 }]; // $10.00
    const periodTotals = [
      { chartOfAccountsId: "coa-wages", amountCents: 3500 }, // $35.00
      { chartOfAccountsId: "coa-taxes", amountCents: 1500 }, // $15.00
    ]; // period total = $50.00, far from the matched expense's $10.00

    const result = computeProportionalSplits(matched, periodTotals);
    const lines = result.get("exp-underpaid")!;
    const sum = lines.reduce((s, l) => s + l.amountCents, 0);

    expect(sum).toBe(1000); // must equal the expense's own amount, NOT 5000
  });

  it("general invariant (property-style): for a variety of matched/period-total combinations -- including matched-total higher than period-total and matched-total lower than period-total -- every expense's lines sum exactly to that expense's own amountCents", () => {
    const cases: { matched: MatchedExpenseAmount[]; periodTotals: { chartOfAccountsId: string; amountCents: number }[] }[] = [
      // matched total ($150.00) higher than period total ($50.00)
      {
        matched: [
          { expenseId: "e1", amountCents: 10000 },
          { expenseId: "e2", amountCents: 5000 },
        ],
        periodTotals: [
          { chartOfAccountsId: "coa-a", amountCents: 3000 },
          { chartOfAccountsId: "coa-b", amountCents: 2000 },
        ],
      },
      // matched total ($10.00) lower than period total ($500.00)
      {
        matched: [{ expenseId: "e3", amountCents: 1000 }],
        periodTotals: [
          { chartOfAccountsId: "coa-a", amountCents: 30000 },
          { chartOfAccountsId: "coa-b", amountCents: 15000 },
          { chartOfAccountsId: "coa-c", amountCents: 5000 },
        ],
      },
      // several expenses, odd cent amounts, matched total lower than period total
      {
        matched: [
          { expenseId: "e4", amountCents: 733 },
          { expenseId: "e5", amountCents: 291 },
          { expenseId: "e6", amountCents: 1 },
        ],
        periodTotals: [
          { chartOfAccountsId: "coa-a", amountCents: 12345 },
          { chartOfAccountsId: "coa-b", amountCents: 6789 },
        ],
      },
      // single bucket, matched total much higher than period total
      {
        matched: [{ expenseId: "e7", amountCents: 999999 }],
        periodTotals: [{ chartOfAccountsId: "coa-only", amountCents: 100 }],
      },
    ];

    for (const { matched, periodTotals } of cases) {
      const result = computeProportionalSplits(matched, periodTotals);
      sumsToExpectedPerExpense(result, matched);
    }
  });
});

describe("planPayrollMatches", () => {
  const periods = [
    { id: "p-jun", endDate: "2026-06-14" },
    { id: "p-jul", endDate: "2026-06-28" },
  ];

  it("assigns each expense to its nearest in-window pay period", () => {
    const plans = planPayrollMatches(
      [
        { id: "e1", expenseDate: "2026-06-15" }, // 1d from p-jun
        { id: "e2", expenseDate: "2026-06-30" }, // 2d from p-jul
      ],
      periods,
    );
    expect(plans).toEqual([
      { expenseId: "e1", payPeriodId: "p-jun" },
      { expenseId: "e2", payPeriodId: "p-jul" },
    ]);
  });

  it("skips expenses with no pay period within the 10-day window", () => {
    const plans = planPayrollMatches(
      [
        { id: "e1", expenseDate: "2026-06-15" }, // matches p-jun
        { id: "e2", expenseDate: "2026-09-01" }, // nothing within 10 days
      ],
      periods,
    );
    expect(plans).toEqual([{ expenseId: "e1", payPeriodId: "p-jun" }]);
  });

  it("returns [] when there are no candidate periods or no expenses", () => {
    expect(planPayrollMatches([{ id: "e1", expenseDate: "2026-06-15" }], [])).toEqual([]);
    expect(planPayrollMatches([], periods)).toEqual([]);
  });
});

describe("recomputePeriodExpenseSplits", () => {
  interface FakeState {
    reports: { id: string; pay_period_id: string; superseded_at: string | null }[];
    totals: { report_id: string; chart_of_accounts_id: string; amount_cents: number }[];
    matches: { pay_period_id: string; expense_id: string }[];
    expenses: { id: string; amount_cents: number }[];
    splits: { id: string; expense_id: string; chart_of_accounts_id: string; amount_cents: number; split_source: string }[];
  }

  function makeClient(state: FakeState) {
    let nextId = 1;
    const client = {
      from(table: string) {
        return {
          select() {
            const rows = () => {
              if (table === "payroll_gl_reports") return state.reports;
              if (table === "payroll_gl_report_totals") return state.totals;
              if (table === "payroll_period_expense_matches") return state.matches;
              if (table === "expenses") return state.expenses;
              if (table === "expense_gl_splits") return state.splits;
              throw new Error(`unexpected table ${table}`);
            };
            const chain = {
              _filters: [] as { col: string; val: unknown }[],
              eq(col: string, val: unknown) {
                this._filters.push({ col, val });
                return this;
              },
              is(col: string, val: unknown) {
                this._filters.push({ col, val });
                return this;
              },
              in(col: string, vals: unknown[]) {
                this._filters.push({ col, val: vals });
                return this;
              },
              order() {
                return this;
              },
              limit() {
                return this;
              },
              then(resolve: (v: { data: unknown; error: null }) => unknown) {
                let data = rows() as Record<string, unknown>[];
                for (const f of this._filters) {
                  data = data.filter((r) => {
                    if (Array.isArray(f.val)) return (f.val as unknown[]).includes(r[f.col]);
                    return r[f.col] === f.val;
                  });
                }
                return Promise.resolve({ data, error: null }).then(resolve);
              },
            };
            return chain;
          },
          delete() {
            const chain = {
              _filters: [] as { col: string; val: unknown }[],
              eq(col: string, val: unknown) {
                this._filters.push({ col, val });
                return this;
              },
              then(resolve: (v: { error: null }) => unknown) {
                if (table === "expense_gl_splits") {
                  state.splits = state.splits.filter((s) => {
                    return !this._filters.every((f) => (s as Record<string, unknown>)[f.col] === f.val);
                  });
                }
                return Promise.resolve({ error: null }).then(resolve);
              },
            };
            return chain;
          },
          insert(rows: Record<string, unknown>[]) {
            return Promise.resolve().then(() => {
              if (table === "expense_gl_splits") {
                for (const r of rows) {
                  state.splits.push({
                    id: `split-${nextId++}`,
                    expense_id: r.expense_id as string,
                    chart_of_accounts_id: r.chart_of_accounts_id as string,
                    amount_cents: r.amount_cents as number,
                    split_source: r.split_source as string,
                  });
                }
              }
              return { error: null };
            });
          },
        };
      },
    };
    return client as unknown as SupabaseClient;
  }

  it("no-ops when the period has no active report", async () => {
    const state: FakeState = {
      reports: [{ id: "report-1", pay_period_id: "period-1", superseded_at: "2026-07-01T00:00:00Z" }],
      totals: [],
      matches: [{ pay_period_id: "period-1", expense_id: "exp-1" }],
      expenses: [{ id: "exp-1", amount_cents: -100000 }],
      splits: [],
    };
    const client = makeClient(state);
    await recomputePeriodExpenseSplits(client, "period-1");
    expect(state.splits).toEqual([]);
  });

  it("regenerates payroll_auto rows for all non-manual matched expenses when an active report exists", async () => {
    const state: FakeState = {
      reports: [{ id: "report-1", pay_period_id: "period-1", superseded_at: null }],
      totals: [
        { report_id: "report-1", chart_of_accounts_id: "coa-a", amount_cents: 60000 },
        { report_id: "report-1", chart_of_accounts_id: "coa-b", amount_cents: 40000 },
      ],
      matches: [
        { pay_period_id: "period-1", expense_id: "exp-1" },
        { pay_period_id: "period-1", expense_id: "exp-2" },
      ],
      expenses: [
        { id: "exp-1", amount_cents: -60000 },
        { id: "exp-2", amount_cents: -40000 },
      ],
      splits: [],
    };
    const client = makeClient(state);
    await recomputePeriodExpenseSplits(client, "period-1");

    const exp1Lines = state.splits.filter((s) => s.expense_id === "exp-1");
    const exp2Lines = state.splits.filter((s) => s.expense_id === "exp-2");
    // Both source expenses are stored negative (outflow) -- split lines must
    // preserve that sign, not the magnitude computeProportionalSplits works in.
    expect(exp1Lines.reduce((s, l) => s + l.amount_cents, 0)).toBe(-60000);
    expect(exp2Lines.reduce((s, l) => s + l.amount_cents, 0)).toBe(-40000);
    expect(state.splits.every((s) => s.split_source === "payroll_auto")).toBe(true);
  });

  it("leaves an expense with a manual split row completely untouched while recomputing its siblings", async () => {
    const state: FakeState = {
      reports: [{ id: "report-1", pay_period_id: "period-1", superseded_at: null }],
      totals: [{ report_id: "report-1", chart_of_accounts_id: "coa-a", amount_cents: 100000 }],
      matches: [
        { pay_period_id: "period-1", expense_id: "exp-manual" },
        { pay_period_id: "period-1", expense_id: "exp-auto" },
      ],
      expenses: [
        { id: "exp-manual", amount_cents: -50000 },
        { id: "exp-auto", amount_cents: -50000 },
      ],
      splits: [
        { id: "existing-manual", expense_id: "exp-manual", chart_of_accounts_id: "coa-manual", amount_cents: -50000, split_source: "manual" },
      ],
    };
    const client = makeClient(state);
    await recomputePeriodExpenseSplits(client, "period-1");

    const manualLines = state.splits.filter((s) => s.expense_id === "exp-manual");
    expect(manualLines).toEqual([
      { id: "existing-manual", expense_id: "exp-manual", chart_of_accounts_id: "coa-manual", amount_cents: -50000, split_source: "manual" },
    ]);

    const autoLines = state.splits.filter((s) => s.expense_id === "exp-auto");
    expect(autoLines.reduce((s, l) => s + l.amount_cents, 0)).toBe(-50000);
    expect(autoLines.every((l) => l.split_source === "payroll_auto")).toBe(true);
  });

  it("write→read round trip: a negative-amount expense's recomputed splits stay negative through aggregateRows on a P&L expenses-section account (regression for the sign-loss bug)", async () => {
    const state: FakeState = {
      reports: [{ id: "report-1", pay_period_id: "period-1", superseded_at: null }],
      totals: [
        { report_id: "report-1", chart_of_accounts_id: "coa-wages", amount_cents: 60000 },
        { report_id: "report-1", chart_of_accounts_id: "coa-taxes", amount_cents: 20000 },
      ],
      matches: [{ pay_period_id: "period-1", expense_id: "exp-net-pay" }],
      expenses: [{ id: "exp-net-pay", amount_cents: -80000 }], // $800 outflow
      splits: [],
    };
    const client = makeClient(state);
    await recomputePeriodExpenseSplits(client, "period-1");

    const splitLines = state.splits
      .filter((s) => s.expense_id === "exp-net-pay")
      .map((s) => ({
        chartOfAccountsId: s.chart_of_accounts_id,
        amountCents: s.amount_cents,
        splitSource: s.split_source as "payroll_auto" | "manual",
      }));

    // Every written line must itself be negative (cost), not just the sum.
    for (const l of splitLines) expect(l.amountCents).toBeLessThan(0);

    const coa: CoaRecord[] = [
      { id: "coa-wages", parentId: null, accountName: "Wages", accountNumber: "6110", accountType: "Expense", statementSection: "expenses" },
      { id: "coa-taxes", parentId: null, accountName: "Payroll Taxes", accountNumber: "6130", accountType: "Expense", statementSection: "expenses" },
    ];
    const expenseRecord: ExpenseRecord = {
      id: "exp-net-pay",
      chartOfAccountsId: null,
      amountCents: -80000,
      accountingDate: "2026-07-15",
      mappingSource: "unmapped",
      splitLines,
    };

    const rows = aggregateRows({
      pos: [],
      invoiceLines: [],
      expenses: [expenseRecord],
      refunds: [],
      bank: [],
      coa,
      months: ["2026-07"],
    });

    expect(rows.length).toBe(splitLines.length);
    const total = rows.reduce((s, r) => s + r.amountCentsByMonth["2026-07"], 0);
    expect(total).toBe(-80000);
    for (const r of rows) expect(r.amountCentsByMonth["2026-07"]).toBeLessThan(0);
  });
});

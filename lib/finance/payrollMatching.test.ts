import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  suggestPayPeriod,
  computeProportionalSplits,
  recomputePeriodExpenseSplits,
  planPayrollMatches,
  type MatchedExpenseAmount,
  type PeriodBucket,
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

describe("computeProportionalSplits — tips carve-out", () => {
  /**
   * Verbatim copy of the pre-tips-carve-out implementation, frozen here as the
   * equivalence oracle for assertion 5: with no `tips` bucket present the new
   * two-stage code must produce byte-identical output to this.
   */
  function legacyComputeProportionalSplits(
    matchedExpenses: MatchedExpenseAmount[],
    periodTotals: { chartOfAccountsId: string; amountCents: number }[],
  ): Map<string, { chartOfAccountsId: string; amountCents: number; splitSource: "payroll_auto" }[]> {
    const periodTotal = periodTotals.reduce((s, b) => s + b.amountCents, 0);
    const ratios = periodTotals.map((b) => (periodTotal > 0 ? b.amountCents / periodTotal : 0));
    const result = new Map<string, { chartOfAccountsId: string; amountCents: number; splitSource: "payroll_auto" }[]>();

    for (const e of matchedExpenses) {
      const lines = periodTotals.map((b, i) => {
        const raw = e.amountCents * ratios[i];
        const floored = Math.floor(raw);
        return { chartOfAccountsId: b.chartOfAccountsId, amountCents: floored, remainder: raw - floored };
      });

      const flooredSum = lines.reduce((s, l) => s + l.amountCents, 0);
      let toDistribute = e.amountCents - flooredSum;

      const order = [...lines.keys()].sort((a, b) => lines[b].remainder - lines[a].remainder);
      for (const idx of order) {
        if (toDistribute <= 0) break;
        lines[idx].amountCents += 1;
        toDistribute -= 1;
      }

      result.set(
        e.expenseId,
        lines.map((l) => ({ chartOfAccountsId: l.chartOfAccountsId, amountCents: l.amountCents, splitSource: "payroll_auto" as const })),
      );
    }

    return result;
  }

  function sumByKind(
    result: Map<string, { chartOfAccountsId: string; amountCents: number }[]>,
    buckets: PeriodBucket[],
    kind: "tips" | "rest",
  ): number {
    const tipIds = new Set(buckets.filter((b) => b.kind === "tips").map((b) => b.chartOfAccountsId));
    let sum = 0;
    for (const lines of result.values()) {
      for (const l of lines) {
        const isTip = tipIds.has(l.chartOfAccountsId);
        if ((kind === "tips") === isTip) sum += l.amountCents;
      }
    }
    return sum;
  }

  // Real prod shape, pay period 2026-06-01 -> 2026-06-14.
  const goldenExpenses: MatchedExpenseAmount[] = [
    { expenseId: "a", amountCents: 548554 },
    { expenseId: "b", amountCents: 166510 },
    { expenseId: "c", amountCents: 65592 },
    { expenseId: "d", amountCents: 13716 },
  ]; // sum = 794372
  const goldenBuckets: PeriodBucket[] = [
    { chartOfAccountsId: "labor", amountCents: 487539, kind: "wages" },
    { chartOfAccountsId: "taproom", amountCents: 62398, kind: "wages" },
    { chartOfAccountsId: "admin", amountCents: 5824, kind: "wages" },
    { chartOfAccountsId: "taxes", amountCents: 65210, kind: "employer_tax" },
    { chartOfAccountsId: "tips", amountCents: 91158, kind: "tips" },
  ]; // wage/tax sum = 620971, + tips = 712129; matched total is 794372 => $822.43 residual

  it("golden case (1): tip lines across all four expenses sum to EXACTLY the period tip total, 91158", () => {
    const result = computeProportionalSplits(goldenExpenses, goldenBuckets);
    const tipSum = sumByKind(result, goldenBuckets, "tips");
    expect(tipSum).toBe(91158);
  });

  it("golden case (1b): each expense's tip line is its exact largest-remainder share of the tip total", () => {
    const result = computeProportionalSplits(goldenExpenses, goldenBuckets);
    const tipOf = (id: string) => result.get(id)!.find((l) => l.chartOfAccountsId === "tips")!.amountCents;
    // 91158 * a_i / 794372, floored, with the 3 leftover cents to the largest
    // remainders (c .9968, d .9768, b .8218).
    expect(tipOf("a")).toBe(62949);
    expect(tipOf("b")).toBe(19108);
    expect(tipOf("c")).toBe(7527);
    expect(tipOf("d")).toBe(1574);
  });

  it("golden case (2): each expense's lines still sum to exactly its own amountCents", () => {
    const result = computeProportionalSplits(goldenExpenses, goldenBuckets);
    for (const e of goldenExpenses) {
      const sum = result.get(e.expenseId)!.reduce((s, l) => s + l.amountCents, 0);
      expect(sum).toBe(e.amountCents);
    }
  });

  it("golden case (3): no line is negative", () => {
    const result = computeProportionalSplits(goldenExpenses, goldenBuckets);
    for (const lines of result.values()) {
      for (const l of lines) expect(l.amountCents).toBeGreaterThanOrEqual(0);
    }
  });

  it("golden case (4): the $822.43 reconciliation residual lands on wage/tax buckets, never on tips", () => {
    const result = computeProportionalSplits(goldenExpenses, goldenBuckets);
    const restSum = sumByKind(result, goldenBuckets, "rest");
    const restBucketTotal = 487539 + 62398 + 5824 + 65210; // 620971

    // Wage/tax lines absorb the whole variance between matched cash and the
    // period's wage/tax GL total: 794372 - 91158 = 703214 = 620971 + 82243.
    expect(restSum).toBe(703214);
    expect(restSum - restBucketTotal).toBe(82243); // $822.43
    // ...and the tips bucket is untouched by it.
    expect(sumByKind(result, goldenBuckets, "tips")).toBe(91158);
  });

  it("golden case (4b): wage/tax lines keep the wage/tax mix among themselves (residual spread pro-rata, not dumped on one account)", () => {
    const result = computeProportionalSplits(goldenExpenses, goldenBuckets);
    const restBucketTotal = 620971;
    const byBucket = new Map<string, number>();
    for (const lines of result.values()) {
      for (const l of lines) byBucket.set(l.chartOfAccountsId, (byBucket.get(l.chartOfAccountsId) ?? 0) + l.amountCents);
    }
    for (const b of goldenBuckets.filter((x) => x.kind !== "tips")) {
      const expected = 703214 * (b.amountCents / restBucketTotal);
      expect(Math.abs((byBucket.get(b.chartOfAccountsId) ?? 0) - expected)).toBeLessThan(5);
    }
  });

  it("(5) equivalence: with no tips bucket, output is identical to the pre-change implementation", () => {
    const cases: { matched: MatchedExpenseAmount[]; buckets: PeriodBucket[] }[] = [
      {
        matched: [
          { expenseId: "exp-net-pay", amountCents: 685205 },
          { expenseId: "exp-tax-debit", amountCents: 80749 },
        ],
        buckets: [
          { chartOfAccountsId: "coa-6110", amountCents: 500000, kind: "wages" },
          { chartOfAccountsId: "coa-5130", amountCents: 200000, kind: "wages" },
          { chartOfAccountsId: "coa-6130", amountCents: 65954, kind: "employer_tax" },
        ],
      },
      {
        matched: goldenExpenses,
        buckets: goldenBuckets.filter((b) => b.kind !== "tips"),
      },
      {
        matched: [
          { expenseId: "e1", amountCents: 10000 },
          { expenseId: "e2", amountCents: 5000 },
        ],
        buckets: [
          { chartOfAccountsId: "coa-a", amountCents: 3000 },
          { chartOfAccountsId: "coa-b", amountCents: 2000 },
        ],
      },
      {
        matched: [{ expenseId: "e3", amountCents: 1000 }],
        buckets: [
          { chartOfAccountsId: "coa-a", amountCents: 30000 },
          { chartOfAccountsId: "coa-b", amountCents: 15000 },
          { chartOfAccountsId: "coa-c", amountCents: 5000 },
        ],
      },
      {
        matched: [
          { expenseId: "e4", amountCents: 733 },
          { expenseId: "e5", amountCents: 291 },
          { expenseId: "e6", amountCents: 1 },
        ],
        buckets: [
          { chartOfAccountsId: "coa-a", amountCents: 12345 },
          { chartOfAccountsId: "coa-b", amountCents: 6789 },
        ],
      },
      {
        matched: [{ expenseId: "e7", amountCents: 999999 }],
        buckets: [{ chartOfAccountsId: "coa-only", amountCents: 100 }],
      },
      {
        matched: [
          { expenseId: "exp-1", amountCents: 111 },
          { expenseId: "exp-2", amountCents: 222 },
          { expenseId: "exp-3", amountCents: 333 },
        ],
        buckets: [
          { chartOfAccountsId: "coa-1", amountCents: 100, kind: "wages" },
          { chartOfAccountsId: "coa-2", amountCents: 200, kind: "wages" },
          { chartOfAccountsId: "coa-3", amountCents: 366, kind: "employer_tax" },
        ],
      },
    ];

    for (const { matched, buckets } of cases) {
      const actual = computeProportionalSplits(matched, buckets);
      const legacy = legacyComputeProportionalSplits(matched, buckets);
      expect([...actual.entries()]).toEqual([...legacy.entries()]);
    }
  });

  it("(6) buckets with kind absent behave as non-tips", () => {
    const matched: MatchedExpenseAmount[] = [{ expenseId: "e1", amountCents: 1000 }];
    const untyped: PeriodBucket[] = [
      { chartOfAccountsId: "coa-a", amountCents: 300 },
      { chartOfAccountsId: "coa-b", amountCents: 200 },
    ];
    const asWages: PeriodBucket[] = untyped.map((b) => ({ ...b, kind: "wages" as const }));
    expect([...computeProportionalSplits(matched, untyped).entries()]).toEqual([
      ...computeProportionalSplits(matched, asWages).entries(),
    ]);
    // and it is scaled (force-filled) like today, not carved out exactly
    expect(computeProportionalSplits(matched, untyped).get("e1")!.reduce((s, l) => s + l.amountCents, 0)).toBe(1000);
  });

  it("(7) single expense, tips-only bucket -> the whole amount goes to tips", () => {
    const matched: MatchedExpenseAmount[] = [{ expenseId: "e1", amountCents: 91158 }];
    const buckets: PeriodBucket[] = [{ chartOfAccountsId: "tips", amountCents: 91158, kind: "tips" }];
    const lines = computeProportionalSplits(matched, buckets).get("e1")!;
    expect(lines).toEqual([{ chartOfAccountsId: "tips", amountCents: 91158, splitSource: "payroll_auto" }]);
  });

  it("(8) tipsTotal > matchedTotal -> tip shares clamp at each expense's own amount, no negative lines", () => {
    const matched: MatchedExpenseAmount[] = [
      { expenseId: "e1", amountCents: 6000 },
      { expenseId: "e2", amountCents: 4000 },
    ];
    const buckets: PeriodBucket[] = [
      { chartOfAccountsId: "wages", amountCents: 5000, kind: "wages" },
      { chartOfAccountsId: "tips", amountCents: 30000, kind: "tips" },
    ];
    const result = computeProportionalSplits(matched, buckets);
    for (const e of matched) {
      const lines = result.get(e.expenseId)!;
      for (const l of lines) expect(l.amountCents).toBeGreaterThanOrEqual(0);
      expect(lines.reduce((s, l) => s + l.amountCents, 0)).toBe(e.amountCents);
      // clamped: everything the expense has goes to tips, nothing left for wages
      expect(lines.find((l) => l.chartOfAccountsId === "tips")!.amountCents).toBe(e.amountCents);
      expect(lines.find((l) => l.chartOfAccountsId === "wages")!.amountCents).toBe(0);
    }
  });

  it("(9) matchedTotal === 0 -> no lines", () => {
    const matched: MatchedExpenseAmount[] = [
      { expenseId: "e1", amountCents: 0 },
      { expenseId: "e2", amountCents: 0 },
    ];
    const buckets: PeriodBucket[] = [
      { chartOfAccountsId: "wages", amountCents: 5000, kind: "wages" },
      { chartOfAccountsId: "tips", amountCents: 1000, kind: "tips" },
    ];
    const result = computeProportionalSplits(matched, buckets);
    for (const lines of result.values()) expect(lines).toEqual([]);
    expect(computeProportionalSplits([], buckets).size).toBe(0);
  });

  it("(10) all-zero non-tips buckets: the even-weight fallback (payrollMatching.ts:183) still allocates the expense IN FULL -- deliberately diverges from the legacy implementation, which under-allocates here (only distributes as many leftover cents as there are buckets, then silently drops the rest)", () => {
    const matched: MatchedExpenseAmount[] = [{ expenseId: "e1", amountCents: 1000 }];
    const buckets: PeriodBucket[] = [
      { chartOfAccountsId: "coa-a", amountCents: 0, kind: "wages" },
      { chartOfAccountsId: "coa-b", amountCents: 0, kind: "wages" },
    ];

    const result = computeProportionalSplits(matched, buckets);
    const lines = result.get("e1")!;

    // Even fallback weight (1 / 2 buckets): 1000 splits into two exact 500s.
    expect(lines).toEqual([
      { chartOfAccountsId: "coa-a", amountCents: 500, splitSource: "payroll_auto" },
      { chartOfAccountsId: "coa-b", amountCents: 500, splitSource: "payroll_auto" },
    ]);
    // Full allocation -- NOT the legacy behavior, which would only place 2
    // cents (one per bucket) and drop the remaining 998.
    expect(lines.reduce((s, l) => s + l.amountCents, 0)).toBe(1000);
  });

  it("multiple tips buckets are each carved out exactly and independently", () => {
    const matched: MatchedExpenseAmount[] = [
      { expenseId: "a", amountCents: 548554 },
      { expenseId: "b", amountCents: 166510 },
      { expenseId: "c", amountCents: 65592 },
      { expenseId: "d", amountCents: 13716 },
    ];
    const buckets: PeriodBucket[] = [
      { chartOfAccountsId: "labor", amountCents: 487539, kind: "wages" },
      { chartOfAccountsId: "tips-cash", amountCents: 91158, kind: "tips" },
      { chartOfAccountsId: "tips-card", amountCents: 13337, kind: "tips" },
    ];
    const result = computeProportionalSplits(matched, buckets);
    const perBucket = new Map<string, number>();
    for (const lines of result.values()) {
      for (const l of lines) perBucket.set(l.chartOfAccountsId, (perBucket.get(l.chartOfAccountsId) ?? 0) + l.amountCents);
    }
    expect(perBucket.get("tips-cash")).toBe(91158);
    expect(perBucket.get("tips-card")).toBe(13337);
    for (const e of matched) {
      expect(result.get(e.expenseId)!.reduce((s, l) => s + l.amountCents, 0)).toBe(e.amountCents);
    }
  });

  it("tips exactness holds across a range of matched/period combinations, alongside per-expense exactness", () => {
    const cases: { matched: MatchedExpenseAmount[]; buckets: PeriodBucket[]; tipsTotal: number }[] = [
      {
        matched: [
          { expenseId: "e1", amountCents: 3 },
          { expenseId: "e2", amountCents: 7 },
          { expenseId: "e3", amountCents: 11 },
        ],
        buckets: [
          { chartOfAccountsId: "w", amountCents: 13, kind: "wages" },
          { chartOfAccountsId: "t", amountCents: 5, kind: "tips" },
        ],
        tipsTotal: 5,
      },
      {
        matched: [
          { expenseId: "e1", amountCents: 100001 },
          { expenseId: "e2", amountCents: 1 },
        ],
        buckets: [
          { chartOfAccountsId: "w", amountCents: 7777, kind: "wages" },
          { chartOfAccountsId: "x", amountCents: 3, kind: "employer_tax" },
          { chartOfAccountsId: "t", amountCents: 33333, kind: "tips" },
        ],
        tipsTotal: 33333,
      },
      {
        // matched total far below the period total: tips still exact, wages absorb the shortfall
        matched: [{ expenseId: "e1", amountCents: 50000 }],
        buckets: [
          { chartOfAccountsId: "w", amountCents: 400000, kind: "wages" },
          { chartOfAccountsId: "t", amountCents: 9999, kind: "tips" },
        ],
        tipsTotal: 9999,
      },
    ];

    for (const { matched, buckets, tipsTotal } of cases) {
      const result = computeProportionalSplits(matched, buckets);
      const tipIds = new Set(buckets.filter((b) => b.kind === "tips").map((b) => b.chartOfAccountsId));
      let tipSum = 0;
      for (const lines of result.values()) {
        for (const l of lines) {
          expect(l.amountCents).toBeGreaterThanOrEqual(0);
          if (tipIds.has(l.chartOfAccountsId)) tipSum += l.amountCents;
        }
      }
      expect(tipSum).toBe(tipsTotal);
      for (const e of matched) {
        expect(result.get(e.expenseId)!.reduce((s, l) => s + l.amountCents, 0)).toBe(e.amountCents);
      }
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
    totals: { report_id: string; chart_of_accounts_id: string; amount_cents: number; bucket_kind?: string }[];
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

  it("maps bucket_kind onto PeriodBucket.kind: the tips bucket is carved out at its exact amount across the period's expenses, signs preserved", async () => {
    const state: FakeState = {
      reports: [{ id: "report-1", pay_period_id: "period-1", superseded_at: null }],
      totals: [
        { report_id: "report-1", chart_of_accounts_id: "coa-wages", amount_cents: 487539, bucket_kind: "wages" },
        { report_id: "report-1", chart_of_accounts_id: "coa-taxes", amount_cents: 65210, bucket_kind: "employer_tax" },
        { report_id: "report-1", chart_of_accounts_id: "coa-tips", amount_cents: 91158, bucket_kind: "tips" },
      ],
      matches: [
        { pay_period_id: "period-1", expense_id: "exp-1" },
        { pay_period_id: "period-1", expense_id: "exp-2" },
      ],
      expenses: [
        { id: "exp-1", amount_cents: -548554 },
        { id: "exp-2", amount_cents: -166510 },
      ],
      splits: [],
    };
    const client = makeClient(state);
    await recomputePeriodExpenseSplits(client, "period-1");

    // Tips liability lines across the whole period sum to exactly the period's
    // tip total (negated, since both source expenses are outflows).
    const tipSum = state.splits.filter((s) => s.chart_of_accounts_id === "coa-tips").reduce((s, l) => s + l.amount_cents, 0);
    expect(tipSum).toBe(-91158);

    for (const id of ["exp-1", "exp-2"]) {
      const lines = state.splits.filter((s) => s.expense_id === id);
      const expected = state.expenses.find((e) => e.id === id)!.amount_cents;
      expect(lines.reduce((s, l) => s + l.amount_cents, 0)).toBe(expected);
      for (const l of lines) expect(l.amount_cents).toBeLessThanOrEqual(0);
    }
  });

  it("nets a manual override's tip posting against the tips target: override posts nothing to tips -> the writable expense covers the FULL period tip total", async () => {
    const state: FakeState = {
      reports: [{ id: "report-1", pay_period_id: "period-1", superseded_at: null }],
      totals: [
        { report_id: "report-1", chart_of_accounts_id: "coa-wages", amount_cents: 100000, bucket_kind: "wages" },
        { report_id: "report-1", chart_of_accounts_id: "coa-tips", amount_cents: 20000, bucket_kind: "tips" },
      ],
      matches: [
        { pay_period_id: "period-1", expense_id: "exp-manual" },
        { pay_period_id: "period-1", expense_id: "exp-auto" },
      ],
      expenses: [
        { id: "exp-manual", amount_cents: -60000 },
        { id: "exp-auto", amount_cents: -60000 },
      ],
      splits: [
        // Manual override posts its whole amount elsewhere -- nothing to coa-tips.
        { id: "existing-manual", expense_id: "exp-manual", chart_of_accounts_id: "coa-other", amount_cents: -60000, split_source: "manual" },
      ],
    };
    const client = makeClient(state);
    await recomputePeriodExpenseSplits(client, "period-1");

    const autoTipLine = state.splits.find((s) => s.expense_id === "exp-auto" && s.chart_of_accounts_id === "coa-tips");
    expect(autoTipLine?.amount_cents).toBe(-20000); // full $200.00 period tip total, netted against $0 already posted

    // exp-manual is untouched.
    expect(state.splits.filter((s) => s.expense_id === "exp-manual")).toEqual([
      { id: "existing-manual", expense_id: "exp-manual", chart_of_accounts_id: "coa-other", amount_cents: -60000, split_source: "manual" },
    ]);

    // Period-wide tips total (manual + auto) still equals the exact period tip total.
    const periodTipSum = state.splits.filter((s) => s.chart_of_accounts_id === "coa-tips").reduce((s, l) => s + l.amount_cents, 0);
    expect(periodTipSum).toBe(-20000);
  });

  it("nets a manual override's tip posting against the tips target: override posts PART of the tips -- the writable expense covers the remainder", async () => {
    const state: FakeState = {
      reports: [{ id: "report-1", pay_period_id: "period-1", superseded_at: null }],
      totals: [
        { report_id: "report-1", chart_of_accounts_id: "coa-wages", amount_cents: 100000, bucket_kind: "wages" },
        { report_id: "report-1", chart_of_accounts_id: "coa-tips", amount_cents: 20000, bucket_kind: "tips" },
      ],
      matches: [
        { pay_period_id: "period-1", expense_id: "exp-manual" },
        { pay_period_id: "period-1", expense_id: "exp-auto" },
      ],
      expenses: [
        { id: "exp-manual", amount_cents: -60000 },
        { id: "exp-auto", amount_cents: -60000 },
      ],
      splits: [
        // Manual override hand-posts $50.00 of the $200.00 period tip total.
        { id: "existing-manual-tips", expense_id: "exp-manual", chart_of_accounts_id: "coa-tips", amount_cents: -5000, split_source: "manual" },
        { id: "existing-manual-rest", expense_id: "exp-manual", chart_of_accounts_id: "coa-other", amount_cents: -55000, split_source: "manual" },
      ],
    };
    const client = makeClient(state);
    await recomputePeriodExpenseSplits(client, "period-1");

    const autoTipLine = state.splits.find((s) => s.expense_id === "exp-auto" && s.chart_of_accounts_id === "coa-tips");
    expect(autoTipLine?.amount_cents).toBe(-15000); // $150.00 remainder: $200.00 - $50.00 already posted

    const periodTipSum = state.splits.filter((s) => s.chart_of_accounts_id === "coa-tips").reduce((s, l) => s + l.amount_cents, 0);
    expect(periodTipSum).toBe(-20000); // manual $50.00 + auto $150.00 = exact period total
  });

  it("nets a manual override's tip posting against the tips target: override posts ALL (or more than) the tips -- the writable expense allocates ZERO, never negative", async () => {
    const state: FakeState = {
      reports: [{ id: "report-1", pay_period_id: "period-1", superseded_at: null }],
      totals: [
        { report_id: "report-1", chart_of_accounts_id: "coa-wages", amount_cents: 100000, bucket_kind: "wages" },
        { report_id: "report-1", chart_of_accounts_id: "coa-tips", amount_cents: 20000, bucket_kind: "tips" },
      ],
      matches: [
        { pay_period_id: "period-1", expense_id: "exp-manual" },
        { pay_period_id: "period-1", expense_id: "exp-auto" },
      ],
      expenses: [
        { id: "exp-manual", amount_cents: -60000 },
        { id: "exp-auto", amount_cents: -60000 },
      ],
      splits: [
        // Manual override over-posts $250.00 against a $200.00 period tip total.
        { id: "existing-manual-tips", expense_id: "exp-manual", chart_of_accounts_id: "coa-tips", amount_cents: -25000, split_source: "manual" },
        { id: "existing-manual-rest", expense_id: "exp-manual", chart_of_accounts_id: "coa-other", amount_cents: -35000, split_source: "manual" },
      ],
    };
    const client = makeClient(state);
    await recomputePeriodExpenseSplits(client, "period-1");

    const autoTipLine = state.splits.find((s) => s.expense_id === "exp-auto" && s.chart_of_accounts_id === "coa-tips");
    // Never a negative allocation -- clamped at zero, and either omitted or
    // present at exactly 0 (this implementation floors the netted target at
    // 0, which computeProportionalSplits then carves out as literally 0).
    // Math.abs guards against a signed -0 (0 * -1) failing a strict toBe(0).
    if (autoTipLine) expect(Math.abs(autoTipLine.amount_cents)).toBe(0);

    // exp-auto's total lines still sum to its own amountCents (invariant 1
    // holds even when tips are fully absorbed by the override).
    const autoSum = state.splits.filter((s) => s.expense_id === "exp-auto").reduce((s, l) => s + l.amount_cents, 0);
    expect(autoSum).toBe(-60000);
  });

  it("treats totals rows with no bucket_kind as non-tips (pre-backfill safe state)", async () => {
    const state: FakeState = {
      reports: [{ id: "report-1", pay_period_id: "period-1", superseded_at: null }],
      totals: [
        { report_id: "report-1", chart_of_accounts_id: "coa-a", amount_cents: 60000 },
        { report_id: "report-1", chart_of_accounts_id: "coa-b", amount_cents: 40000 },
      ],
      matches: [{ pay_period_id: "period-1", expense_id: "exp-1" }],
      expenses: [{ id: "exp-1", amount_cents: -120000 }],
      splits: [],
    };
    const client = makeClient(state);
    await recomputePeriodExpenseSplits(client, "period-1");

    const lines = state.splits.filter((s) => s.expense_id === "exp-1");
    // Pure force-fill, exactly as before the tips change: 60/40 of $1200.
    expect(lines.map((l) => l.amount_cents).sort((a, b) => a - b)).toEqual([-72000, -48000]);
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
      tipAccruals: [],
      taxAccruals: [],
      coa,
      months: ["2026-07"],
    });

    expect(rows.length).toBe(splitLines.length);
    const total = rows.reduce((s, r) => s + r.amountCentsByMonth["2026-07"], 0);
    expect(total).toBe(-80000);
    for (const r of rows) expect(r.amountCentsByMonth["2026-07"]).toBeLessThan(0);
  });
});

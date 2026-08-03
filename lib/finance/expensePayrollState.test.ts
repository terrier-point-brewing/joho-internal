import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getExpensePayrollState } from "./expensePayrollState";

// Minimal thenable chain: every query method returns `this`; the terminal
// awaits (`single`/`maybeSingle`/`then`) resolve to the per-table result.
type Result = { data: unknown; error: unknown };

function makeSb(byTable: Record<string, Result>): SupabaseClient {
  const from = (table: string) => {
    const result = byTable[table] ?? { data: null, error: null };
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "is", "order"]) chain[m] = () => chain;
    chain.single = async () => result;
    chain.maybeSingle = async () => result;
    chain.then = (resolve: (v: unknown) => void) => Promise.resolve(result).then(resolve);
    return chain;
  };
  return { from } as unknown as SupabaseClient;
}

describe("getExpensePayrollState", () => {
  it("returns null match (but still resolves GL lines) when the expense is unmatched", async () => {
    const sb = makeSb({
      payroll_period_expense_matches: { data: null, error: null },
      expense_gl_splits: { data: [], error: null },
      expenses: { data: { chart_of_accounts_id: "C1", amount_cents: -5000 }, error: null },
    });

    const state = await getExpensePayrollState(sb, "E1");

    expect(state.payrollMatch).toBeNull();
    expect(state.glLines).toEqual([{ chartOfAccountsId: "C1", amountCents: -5000, splitSource: null }]);
  });

  it("includes the period date range and hasReport=false when matched but no Gusto report exists yet", async () => {
    const sb = makeSb({
      payroll_period_expense_matches: { data: { pay_period_id: "P1" }, error: null },
      pay_periods: { data: { start_date: "2026-07-01", end_date: "2026-07-15" }, error: null },
      payroll_gl_reports: { data: null, error: null },
      expense_gl_splits: { data: [], error: null },
      expenses: { data: { chart_of_accounts_id: "C1", amount_cents: -5000 }, error: null },
    });

    const state = await getExpensePayrollState(sb, "E1");

    expect(state.payrollMatch).toEqual({
      payPeriodId: "P1",
      periodStart: "2026-07-01",
      periodEnd: "2026-07-15",
      hasReport: false,
      // Null, not absent: this row was matched without a component, which is
      // what a hand-match (or a pre-amount-matching row) looks like.
      matchedComponent: null,
    });
  });

  it("sets hasReport=true and returns the split lines when an active report exists", async () => {
    const sb = makeSb({
      payroll_period_expense_matches: { data: { pay_period_id: "P1" }, error: null },
      pay_periods: { data: { start_date: "2026-07-01", end_date: "2026-07-15" }, error: null },
      payroll_gl_reports: { data: { pay_period_id: "P1" }, error: null },
      expense_gl_splits: {
        data: [
          { chart_of_accounts_id: "C1", amount_cents: -3000, split_source: "payroll_auto" },
          { chart_of_accounts_id: "C2", amount_cents: -2000, split_source: "payroll_auto" },
        ],
        error: null,
      },
    });

    const state = await getExpensePayrollState(sb, "E1");

    expect(state.payrollMatch?.hasReport).toBe(true);
    expect(state.glLines).toHaveLength(2);
    expect(state.glLines[0]).toEqual({ chartOfAccountsId: "C1", amountCents: -3000, splitSource: "payroll_auto", memo: null });
  });
});

describe("getExpensePayrollState — matched component", () => {
  it("surfaces which of Gusto's two debits an amount-matched charge is", async () => {
    const sb = makeSb({
      payroll_period_expense_matches: { data: { pay_period_id: "P1", matched_component: "net_pay" }, error: null },
      pay_periods: { data: { start_date: "2026-07-13", end_date: "2026-07-26" }, error: null },
      payroll_gl_reports: { data: { pay_period_id: "P1" }, error: null },
      expense_gl_splits: { data: [], error: null },
      expenses: { data: { chart_of_accounts_id: "C1", amount_cents: -572389 }, error: null },
    });

    const state = await getExpensePayrollState(sb, "E1");

    expect(state.payrollMatch?.matchedComponent).toBe("net_pay");
  });

  /** An unrecognised value must not reach the UI as a label — a component this
   *  build does not know is indistinguishable from no component at all. */
  it("treats an unknown component value as no component", async () => {
    const sb = makeSb({
      payroll_period_expense_matches: { data: { pay_period_id: "P1", matched_component: "something_else" }, error: null },
      pay_periods: { data: { start_date: "2026-07-13", end_date: "2026-07-26" }, error: null },
      payroll_gl_reports: { data: null, error: null },
      expense_gl_splits: { data: [], error: null },
      expenses: { data: { chart_of_accounts_id: "C1", amount_cents: -100 }, error: null },
    });

    const state = await getExpensePayrollState(sb, "E1");

    expect(state.payrollMatch?.matchedComponent).toBeNull();
  });
});

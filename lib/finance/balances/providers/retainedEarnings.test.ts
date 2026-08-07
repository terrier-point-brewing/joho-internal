// GL 3300 (Retained Earnings) -- cumulative P&L net income from inception
// through periodEnd, reusing aggregateRows/buildKpis (the same pipeline the
// P&L statement uses) so this can never drift into its own net-income
// formula. A generic table->rows fake stands in for Supabase; it does not
// re-implement each fetch's own filter semantics (those are already covered
// by fetchSources.test.ts) -- only the fixtures relevant to each test are
// populated.
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { retainedEarnings, monthsThroughPeriodEnd } from "./retainedEarnings";
import type { BalanceContext } from "../registry";

function fakeClient(tables: Record<string, unknown[]>): SupabaseClient {
  const makeChain = (rows: unknown[]) => {
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      neq: () => chain,
      lt: () => chain,
      lte: () => chain,
      gte: () => chain,
      is: () => chain,
      or: () => chain,
      filter: () => chain,
      in: () => chain,
      order: () => chain,
      range: async (from: number, to: number) => ({ data: rows.slice(from, to + 1), error: null }),
    };
    return chain;
  };
  return {
    from: (table: string) => makeChain(tables[table] ?? []),
  } as unknown as SupabaseClient;
}

function ctx(supabase: SupabaseClient, periodEnd: string): BalanceContext {
  return { supabase, periodEnd, coaId: "coa-3300", config: {} };
}

describe("retainedEarnings", () => {
  it("sums P&L net income across the whole inception-to-periodEnd range into one cumulative figure, negated for equity's internal-convention sign", async () => {
    const supabase = fakeClient({
      chart_of_accounts: [
        { id: "rev-1", parent_id: null, account_name: "Taproom Revenue", account_number: "4100", account_type: "Income", statement_section: null },
        { id: "exp-1", parent_id: null, account_name: "Supplies", account_number: "6000", account_type: "Expenses", statement_section: null },
      ],
      pos_line_items: [
        {
          id: "p1",
          net_sales_cents: 100000,
          quantity: 1,
          variation_name: null,
          chart_of_accounts_id: "rev-1",
          square_variation_id: null,
          square_orders: { transaction_date: "2026-01-15T12:00:00Z", invoice_id: null },
        },
      ],
      invoice_line_items: [
        {
          id: "i1",
          total_cents: 50000,
          category: null,
          chart_of_accounts_id: "rev-1",
          invoices: {
            id: "inv-1",
            invoice_date: "2026-02-10",
            status: "open",
            export_transactions: [],
            allocation_id: null,
            batch_allocations: null,
          },
        },
      ],
      expenses: [
        {
          id: "e1",
          chart_of_accounts_id: "exp-1",
          amount_cents: -30000,
          accounting_date: "2026-01-20",
          mapping_source: "manual",
          state: null,
        },
      ],
    });

    // periodEnd's month (Feb) alone would miss the January activity if this
    // provider only looked at the period-end month -- proving cumulative
    // (inception-to-periodEnd) summation, not a single-month read.
    const result = await retainedEarnings.compute(ctx(supabase, "2026-02-28"));

    // Net income = 100000 (POS revenue) + 50000 (invoice revenue) - 30000 (expense) = 120000.
    // Equity is negative internal-convention: -120000.
    expect(result).toBe(-120000);
  });

  it("returns 0, not null, for a period with no P&L activity", async () => {
    const supabase = fakeClient({});

    const result = await retainedEarnings.compute(ctx(supabase, "2026-01-31"));

    expect(result).toBe(0);
    expect(result).not.toBeNull();
  });

  // The regression this file previously had no way to catch. Collapsing every
  // record onto periodEnd's month and asking aggregateRows for that one month
  // looked like it summed the range, but aggregateRows re-derives a
  // payroll-matched expense's month from its PAY PERIOD -- which the collapse
  // never touched -- and then keeps only the months it was asked for. Against
  // the live database that discarded 3,440,991 cents of P&L-section payroll and
  // overstated equity by the same.
  it("counts a payroll expense whose pay period falls entirely outside periodEnd's month", async () => {
    const supabase = fakeClient({
      chart_of_accounts: [
        { id: "rev-1", parent_id: null, account_name: "Taproom Revenue", account_number: "4100", account_type: "Income", statement_section: null },
        { id: "exp-1", parent_id: null, account_name: "Wages", account_number: "6100", account_type: "Expenses", statement_section: null },
      ],
      pos_line_items: [
        {
          id: "p1",
          net_sales_cents: 100000,
          quantity: 1,
          variation_name: null,
          chart_of_accounts_id: "rev-1",
          square_variation_id: null,
          square_orders: { transaction_date: "2026-01-15T12:00:00Z", invoice_id: null },
        },
      ],
      expenses: [
        {
          id: "e1",
          chart_of_accounts_id: "exp-1",
          amount_cents: -40000,
          // Accounting date is inside the range but in JANUARY, and the matched
          // pay period is January too -- so every prorated allocation lands in a
          // month that is not periodEnd's.
          accounting_date: "2026-01-31",
          mapping_source: "manual",
          state: null,
        },
      ],
      payroll_period_expense_matches: [{ expense_id: "e1", pay_period_id: "pp-1" }],
      pay_periods: [{ id: "pp-1", start_date: "2026-01-16", end_date: "2026-01-31" }],
    });

    const result = await retainedEarnings.compute(ctx(supabase, "2026-02-28"));

    // 100000 revenue - 40000 payroll = 60000 net income, negated for equity.
    // The old canonical-month collapse returned -100000 here: the whole payroll
    // expense was dropped because none of it was allocated to February.
    expect(result).toBe(-60000);
  });
});

describe("monthsThroughPeriodEnd", () => {
  it("spans every month from the earliest date given through periodEnd's month, and stops there", () => {
    expect(monthsThroughPeriodEnd(["2026-11-04T09:00:00Z", "2027-01-20"], "2027-02-28")).toEqual([
      "2026-11",
      "2026-12",
      "2027-01",
      "2027-02",
    ]);
  });

  // A month missing from this list is a month aggregateRows silently drops, so
  // a pay period starting before any transaction still has to widen the window.
  it("takes its lower bound from a pay-period start earlier than any other record", () => {
    expect(monthsThroughPeriodEnd(["2026-03-10", "2026-02-24"], "2026-04-30")).toEqual([
      "2026-02",
      "2026-03",
      "2026-04",
    ]);
  });

  it("ignores null and short dates rather than widening the window to the epoch", () => {
    expect(monthsThroughPeriodEnd([null, undefined, "2026", "2026-05-02"], "2026-06-30")).toEqual(["2026-05", "2026-06"]);
  });

  it("is periodEnd's month alone when there is nothing earlier", () => {
    expect(monthsThroughPeriodEnd([], "2026-06-30")).toEqual(["2026-06"]);
    expect(monthsThroughPeriodEnd(["2026-09-01"], "2026-06-30")).toEqual(["2026-06"]);
  });
});

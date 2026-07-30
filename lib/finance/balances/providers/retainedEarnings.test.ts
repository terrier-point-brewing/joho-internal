// GL 3300 (Retained Earnings) -- cumulative P&L net income from inception
// through periodEnd, reusing aggregateRows/buildKpis (the same pipeline the
// P&L statement uses) so this can never drift into its own net-income
// formula. A generic table->rows fake stands in for Supabase; it does not
// re-implement each fetch's own filter semantics (those are already covered
// by fetchSources.test.ts) -- only the fixtures relevant to each test are
// populated.
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { retainedEarnings } from "./retainedEarnings";
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
      ilike: () => chain,
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
});

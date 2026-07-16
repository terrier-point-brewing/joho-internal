// Covers fetchExpenses's expense_gl_splits batch-join in isolation (the rest
// of fetchFinancialsSources's per-source fetches are exercised indirectly via
// buildFinancials.test.ts, which mocks fetchFinancialsSources wholesale).
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchExpenses } from "./fetchSources";

interface ExpensesRow {
  id: string;
  chart_of_accounts_id: string | null;
  amount_cents: number | null;
  accounting_date: string;
  mapping_source: string | null;
  state: string | null;
}

interface SplitRow {
  expense_id: string;
  chart_of_accounts_id: string;
  amount_cents: number;
  split_source: string;
}

/**
 * Fake Supabase client for `expenses` + `expense_gl_splits`. Query-builder
 * chain methods are no-ops that return `this`; `.range()` on the `expenses`
 * table paginates via fetchAllRows the same way lib/supabase/paginate.test.ts
 * does; `.in()` on `expense_gl_splits` records its call count/args so tests
 * can assert the join is a single batched query, not one per expense.
 */
function fakeClient(opts: { expenses: ExpensesRow[]; splits: SplitRow[] }) {
  const splitsQueryCalls: { table: string; inArgs?: [string, unknown[]] }[] = [];

  const client = {
    from(table: string) {
      if (table === "expenses") {
        const chain: Record<string, unknown> = {
          select: () => chain,
          lte: () => chain,
          gte: () => chain,
          eq: () => chain,
          or: () => chain,
          order: () => chain,
          range: async (from: number, to: number) => ({ data: opts.expenses.slice(from, to + 1), error: null }),
        };
        return chain;
      }
      if (table === "expense_gl_splits") {
        const call: { table: string; inArgs?: [string, unknown[]] } = { table };
        splitsQueryCalls.push(call);
        const chain: Record<string, unknown> = {
          select: () => chain,
          in: (col: string, vals: unknown[]) => {
            call.inArgs = [col, vals];
            return chain;
          },
          order: () => chain,
          range: async (from: number, to: number) => {
            const ids = new Set(call.inArgs?.[1] ?? []);
            const filtered = opts.splits.filter((s) => ids.has(s.expense_id));
            return { data: filtered.slice(from, to + 1), error: null };
          },
        };
        return chain;
      }
      throw new Error(`unexpected table ${table}`);
    },
  };

  return { client: client as unknown as SupabaseClient, splitsQueryCalls };
}

const RANGE = { startDateStr: "2026-01-01", start: "2026-01-01T00:00:00Z", endDateStr: "2026-01-31", end: "2026-02-01T00:00:00Z" };

describe("fetchExpenses", () => {
  it("attaches splitLines only to expenses that have expense_gl_splits rows, in one batched query", async () => {
    const { client, splitsQueryCalls } = fakeClient({
      expenses: [
        { id: "exp-1", chart_of_accounts_id: "coa-a", amount_cents: -1000, accounting_date: "2026-01-05", mapping_source: "rule", state: null },
        { id: "exp-2", chart_of_accounts_id: null, amount_cents: -2000, accounting_date: "2026-01-10", mapping_source: "unmapped", state: null },
        { id: "exp-3", chart_of_accounts_id: "coa-b", amount_cents: -500, accounting_date: "2026-01-12", mapping_source: "rule", state: null },
      ],
      splits: [
        { expense_id: "exp-1", chart_of_accounts_id: "coa-x", amount_cents: -700, split_source: "payroll_auto" },
        { expense_id: "exp-1", chart_of_accounts_id: "coa-y", amount_cents: -300, split_source: "payroll_auto" },
      ],
    });

    const result = await fetchExpenses(client, RANGE, false);

    expect(result).toHaveLength(3);
    const exp1 = result.find((r) => r.id === "exp-1")!;
    const exp2 = result.find((r) => r.id === "exp-2")!;
    const exp3 = result.find((r) => r.id === "exp-3")!;

    expect(exp1.splitLines).toEqual([
      { chartOfAccountsId: "coa-x", amountCents: -700, splitSource: "payroll_auto" },
      { chartOfAccountsId: "coa-y", amountCents: -300, splitSource: "payroll_auto" },
    ]);
    expect(exp2.splitLines ?? []).toEqual([]);
    expect(exp3.splitLines ?? []).toEqual([]);

    // Exactly one expense_gl_splits query (batched .in(), not one per expense).
    expect(splitsQueryCalls).toHaveLength(1);
    expect(splitsQueryCalls[0].inArgs?.[0]).toBe("expense_id");
    expect(splitsQueryCalls[0].inArgs?.[1]).toEqual(["exp-1", "exp-2", "exp-3"]);
  });

  it("does not query expense_gl_splits at all when there are no expenses in range", async () => {
    const { client, splitsQueryCalls } = fakeClient({ expenses: [], splits: [] });
    const result = await fetchExpenses(client, RANGE, false);
    expect(result).toEqual([]);
    expect(splitsQueryCalls).toHaveLength(0);
  });
});

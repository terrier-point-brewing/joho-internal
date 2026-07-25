import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveExpenseGlLines, getExpenseGlLines } from "./expenseGlLines";

describe("resolveExpenseGlLines", () => {
  it("returns split rows verbatim (splitSource preserved) when they exist", () => {
    const splitRows = [
      { chartOfAccountsId: "coa-6110", amountCents: 400000, splitSource: "payroll_auto" as const },
      { chartOfAccountsId: "coa-6130", amountCents: 285249, splitSource: "manual" as const },
    ];
    const result = resolveExpenseGlLines(splitRows, { chartOfAccountsId: "coa-fallback", amountCents: 685249 });
    expect(result).toEqual(splitRows);
  });

  it("synthesizes a single line from the fallback when no split rows exist and fallback has a CoA", () => {
    const result = resolveExpenseGlLines([], { chartOfAccountsId: "coa-payroll", amountCents: 123456 });
    expect(result).toEqual([{ chartOfAccountsId: "coa-payroll", amountCents: 123456, splitSource: null }]);
  });

  it("returns [] when no split rows exist and fallback has no CoA (unmapped)", () => {
    const result = resolveExpenseGlLines([], { chartOfAccountsId: null, amountCents: 123456 });
    expect(result).toEqual([]);
  });
});

describe("getExpenseGlLines", () => {
  function stubClient(opts: {
    splitRows: { chart_of_accounts_id: string; amount_cents: number; split_source: string }[];
    expenseRow?: { chart_of_accounts_id: string | null; amount_cents: number } | null;
  }) {
    const calls: string[] = [];
    const client = {
      from: (table: string) => {
        calls.push(table);
        if (table === "expense_gl_splits") {
          return {
            select: () => ({
              eq: () => Promise.resolve({ data: opts.splitRows, error: null }),
            }),
          };
        }
        if (table === "expenses") {
          return {
            select: () => ({
              eq: () => ({
                single: () => Promise.resolve({ data: opts.expenseRow ?? null, error: null }),
              }),
            }),
          };
        }
        throw new Error(`unexpected table ${table}`);
      },
    };
    return { client: client as unknown as SupabaseClient, calls };
  }

  it("delegates to split rows when present, without querying the expenses table", async () => {
    const { client, calls } = stubClient({
      splitRows: [
        { chart_of_accounts_id: "coa-6110", amount_cents: 400000, split_source: "payroll_auto" },
      ],
    });

    const result = await getExpenseGlLines(client, "exp-1");

    // memo is null, not absent: the fixture row has no memo column value, and
    // getExpenseGlLines normalizes a missing/null memo to null so every split
    // line has the same shape regardless of which path built it.
    expect(result).toEqual([{ chartOfAccountsId: "coa-6110", amountCents: 400000, splitSource: "payroll_auto", memo: null }]);
    expect(calls).toEqual(["expense_gl_splits"]);
  });

  it("falls back to the expense's own account/amount when no split rows exist", async () => {
    const { client, calls } = stubClient({
      splitRows: [],
      expenseRow: { chart_of_accounts_id: "coa-supplies", amount_cents: 5000 },
    });

    const result = await getExpenseGlLines(client, "exp-2");

    expect(result).toEqual([{ chartOfAccountsId: "coa-supplies", amountCents: 5000, splitSource: null }]);
    expect(calls).toEqual(["expense_gl_splits", "expenses"]);
  });

  it("returns [] when no split rows and the expense has no chart_of_accounts_id", async () => {
    const { client } = stubClient({
      splitRows: [],
      expenseRow: { chart_of_accounts_id: null, amount_cents: 5000 },
    });

    const result = await getExpenseGlLines(client, "exp-3");

    expect(result).toEqual([]);
  });
});

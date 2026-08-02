// Covers fetchExpenses's expense_gl_splits + payroll-period batch-joins and
// fetchInvoiceLines's channel-derivation fallback in isolation (the rest of
// fetchFinancialsSources's per-source fetches are exercised indirectly via
// buildFinancials.test.ts, which mocks fetchFinancialsSources wholesale).
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchExpenses, fetchInvoiceLines, fetchBank } from "./fetchSources";

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

interface MatchRow {
  expense_id: string;
  pay_period_id: string;
}

interface PeriodRow {
  id: string;
  start_date: string;
  end_date: string;
}

/**
 * Fake Supabase client for `expenses` + `expense_gl_splits` +
 * `payroll_period_expense_matches` + `pay_periods`. Query-builder chain
 * methods are no-ops that return `this`; `.range()` on the `expenses` table
 * paginates via fetchAllRows the same way lib/supabase/paginate.test.ts
 * does; `.in()` on the joined tables records its call count/args so tests
 * can assert each join is a single batched query, not one per expense.
 */
function fakeClient(opts: { expenses: ExpensesRow[]; splits: SplitRow[]; matches?: MatchRow[]; periods?: PeriodRow[] }) {
  const splitsQueryCalls: { table: string; inArgs?: [string, unknown[]] }[] = [];
  const matchesQueryCalls: { table: string; inArgs?: [string, unknown[]] }[] = [];
  const periodsQueryCalls: { table: string; inArgs?: [string, unknown[]] }[] = [];

  const client = {
    from(table: string) {
      if (table === "expenses") {
        const chain: Record<string, unknown> = {
          select: () => chain,
          lte: () => chain,
          gte: () => chain,
          eq: () => chain,
          or: () => chain,
          ilike: () => chain,
          is: () => chain,
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
      if (table === "payroll_period_expense_matches") {
        const call: { table: string; inArgs?: [string, unknown[]] } = { table };
        matchesQueryCalls.push(call);
        const chain: Record<string, unknown> = {
          select: () => chain,
          in: (col: string, vals: unknown[]) => {
            call.inArgs = [col, vals];
            return chain;
          },
          order: () => chain,
          range: async (from: number, to: number) => {
            const ids = new Set(call.inArgs?.[1] ?? []);
            const filtered = (opts.matches ?? []).filter((m) => ids.has(m.expense_id));
            return { data: filtered.slice(from, to + 1), error: null };
          },
        };
        return chain;
      }
      if (table === "pay_periods") {
        const call: { table: string; inArgs?: [string, unknown[]] } = { table };
        periodsQueryCalls.push(call);
        const chain: Record<string, unknown> = {
          select: () => chain,
          in: (col: string, vals: unknown[]) => {
            call.inArgs = [col, vals];
            return chain;
          },
          order: () => chain,
          range: async (from: number, to: number) => {
            const ids = new Set(call.inArgs?.[1] ?? []);
            const filtered = (opts.periods ?? []).filter((p) => ids.has(p.id));
            return { data: filtered.slice(from, to + 1), error: null };
          },
        };
        return chain;
      }
      throw new Error(`unexpected table ${table}`);
    },
  };

  return { client: client as unknown as SupabaseClient, splitsQueryCalls, matchesQueryCalls, periodsQueryCalls };
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

  it("does not query expense_gl_splits, payroll_period_expense_matches, or pay_periods at all when there are no expenses in range", async () => {
    const { client, splitsQueryCalls, matchesQueryCalls, periodsQueryCalls } = fakeClient({ expenses: [], splits: [] });
    const result = await fetchExpenses(client, RANGE, false);
    expect(result).toEqual([]);
    expect(splitsQueryCalls).toHaveLength(0);
    expect(matchesQueryCalls).toHaveLength(0);
    expect(periodsQueryCalls).toHaveLength(0);
  });

  it("attaches payrollPeriod (start/end) only to expenses matched to a pay period, via two batched joins", async () => {
    const { client, matchesQueryCalls, periodsQueryCalls } = fakeClient({
      expenses: [
        { id: "exp-1", chart_of_accounts_id: "coa-a", amount_cents: -42000, accounting_date: "2026-01-05", mapping_source: "rule", state: null },
        { id: "exp-2", chart_of_accounts_id: "coa-b", amount_cents: -1000, accounting_date: "2026-01-10", mapping_source: "rule", state: null },
      ],
      splits: [],
      matches: [{ expense_id: "exp-1", pay_period_id: "period-1" }],
      periods: [{ id: "period-1", start_date: "2026-05-25", end_date: "2026-06-07" }],
    });

    const result = await fetchExpenses(client, RANGE, false);

    const exp1 = result.find((r) => r.id === "exp-1")!;
    const exp2 = result.find((r) => r.id === "exp-2")!;
    expect(exp1.payrollPeriod).toEqual({ start: "2026-05-25", end: "2026-06-07" });
    expect(exp2.payrollPeriod ?? null).toBeNull();

    // One batched query per join, not one per expense.
    expect(matchesQueryCalls).toHaveLength(1);
    expect(matchesQueryCalls[0].inArgs?.[1]).toEqual(["exp-1", "exp-2"]);
    expect(periodsQueryCalls).toHaveLength(1);
    expect(periodsQueryCalls[0].inArgs?.[1]).toEqual(["period-1"]);
  });

  it("does not query pay_periods when no expense in range has a payroll match", async () => {
    const { client, matchesQueryCalls, periodsQueryCalls } = fakeClient({
      expenses: [{ id: "exp-1", chart_of_accounts_id: "coa-a", amount_cents: -1000, accounting_date: "2026-01-05", mapping_source: "rule", state: null }],
      splits: [],
      matches: [],
      periods: [],
    });

    const result = await fetchExpenses(client, RANGE, false);
    expect(result[0].payrollPeriod ?? null).toBeNull();
    expect(matchesQueryCalls).toHaveLength(1);
    expect(periodsQueryCalls).toHaveLength(0);
  });
});

// ── fetchInvoiceLines channel-derivation fallback ───────────────────────────

interface InvoiceLineRow {
  id: string;
  total_cents: number | null;
  category: string | null;
  chart_of_accounts_id: string | null;
  invoices: {
    id: string;
    invoice_date: string;
    status: string;
    export_transactions: { channel: string; volume_bbl: number | null; batch_id?: string | null; is_phantom?: boolean }[];
    allocation_id: string | null;
    batch_allocations: { channel: string } | null;
  };
}

function fakeInvoiceLinesClient(rows: InvoiceLineRow[]) {
  const chain: Record<string, unknown> = {
    select: () => chain,
    neq: () => chain,
    lte: () => chain,
    gte: () => chain,
    eq: () => chain,
    order: () => chain,
    range: async (from: number, to: number) => ({ data: rows.slice(from, to + 1), error: null }),
  };
  const client = { from: () => chain };
  return client as unknown as SupabaseClient;
}

describe("fetchInvoiceLines", () => {
  it("uses export_transactions.channel when present, ignoring the invoice's allocation channel", async () => {
    const client = fakeInvoiceLinesClient([
      {
        id: "line-1", total_cents: 1000, category: null, chart_of_accounts_id: "coa-a",
        invoices: {
          id: "inv-1", invoice_date: "2026-06-01", status: "paid",
          export_transactions: [{ channel: "contract_brewing", volume_bbl: null }],
          allocation_id: "alloc-1", batch_allocations: { channel: "distribution" },
        },
      },
    ]);

    const [row] = await fetchInvoiceLines(client, RANGE, false);
    expect(row.exportChannel).toBe("contract_brewing");
  });

  it("falls back to the linked allocation's channel when the invoice has no export_transactions (e.g. a deposit invoice)", async () => {
    const client = fakeInvoiceLinesClient([
      {
        id: "line-deposit", total_cents: 50000, category: null, chart_of_accounts_id: "coa-4320",
        invoices: {
          id: "inv-deposit", invoice_date: "2026-06-01", status: "paid",
          export_transactions: [],
          allocation_id: "alloc-2", batch_allocations: { channel: "distribution" },
        },
      },
    ]);

    const [row] = await fetchInvoiceLines(client, RANGE, false);
    expect(row.exportChannel).toBe("distribution");
  });

  it("resolves null (unknown) when there's no export_transactions and no linked allocation", async () => {
    const client = fakeInvoiceLinesClient([
      {
        id: "line-standard", total_cents: 2000, category: null, chart_of_accounts_id: "coa-b",
        invoices: {
          id: "inv-standard", invoice_date: "2026-06-01", status: "paid",
          export_transactions: [], allocation_id: null, batch_allocations: null,
        },
      },
    ]);

    const [row] = await fetchInvoiceLines(client, RANGE, false);
    expect(row.exportChannel).toBeNull();
  });

  it("does not fall back to an allocation channel outside the Channel union (e.g. safety_stock)", async () => {
    const client = fakeInvoiceLinesClient([
      {
        id: "line-safety", total_cents: 3000, category: null, chart_of_accounts_id: "coa-c",
        invoices: {
          id: "inv-safety", invoice_date: "2026-06-01", status: "paid",
          export_transactions: [], allocation_id: "alloc-3", batch_allocations: { channel: "safety_stock" },
        },
      },
    ]);

    const [row] = await fetchInvoiceLines(client, RANGE, false);
    expect(row.exportChannel).toBeNull();
  });

  it("does not use the allocation fallback when export_transactions exist but are ambiguous (2+ distinct channels)", async () => {
    const client = fakeInvoiceLinesClient([
      {
        id: "line-ambiguous", total_cents: 4000, category: null, chart_of_accounts_id: "coa-d",
        invoices: {
          id: "inv-ambiguous", invoice_date: "2026-06-01", status: "paid",
          export_transactions: [
            { channel: "contract_brewing", volume_bbl: null },
            { channel: "distribution", volume_bbl: null },
          ],
          allocation_id: "alloc-4", batch_allocations: { channel: "wholesale" },
        },
      },
    ]);

    const [row] = await fetchInvoiceLines(client, RANGE, false);
    expect(row.exportChannel).toBeNull();
  });

  // export_transactions.batch_id is nullable (phantom taproom keg-swap rows —
  // is_phantom=true, batch_id=null — represent booked barrel excise with no
  // cold-storage batch to deduct from). The embed here is a plain
  // `export_transactions ( channel, volume_bbl )` (LEFT-join equivalent), so a
  // phantom row must still resolve its channel/volume like any other row.
  it("includes a phantom (null batch_id, is_phantom=true) export row's channel and volume", async () => {
    const client = fakeInvoiceLinesClient([
      {
        id: "line-phantom", total_cents: 1500, category: "distribution_keg", chart_of_accounts_id: "coa-e",
        invoices: {
          id: "inv-phantom", invoice_date: "2026-06-01", status: "paid",
          export_transactions: [{ channel: "taproom", volume_bbl: 0.5, batch_id: null, is_phantom: true }],
          allocation_id: null, batch_allocations: null,
        },
      },
    ]);

    const [row] = await fetchInvoiceLines(client, RANGE, false);
    // "taproom" isn't in EXPORT_CHANNELS (distribution/contract_brewing/wholesale),
    // so exportChannel resolves null here — the point of this test is that the
    // phantom row is read at all (not dropped) and its volume flows through.
    expect(row.exportChannel).toBeNull();
    expect(row.volumeBbl).toBe(0.5);
  });
});

/**
 * fetchBank and the operator's bank-feed rules.
 *
 * This is the read behind the profit and loss, the cash-flow statement and the
 * transactions grid, all of which are verified and in production use. So the
 * first test is the one that matters: with no rules stored -- which is the
 * production state, and stays the production state until somebody uses the GL
 * Mapping screen -- the query built is the SAME `.eq("include_in_gl", true)`
 * that was here before, and every row it returns is kept.
 */
interface BankRow {
  id: string;
  chart_of_accounts_id: string | null;
  amount_cents: number | null;
  transaction_date: string;
  mapping_source: string | null;
  source: string;
  counterparty_key: string | null;
  counterparty_name: string | null;
  include_in_gl: boolean;
}

function fakeBankClient(rows: Partial<BankRow>[], glRules: unknown[] = []) {
  const calls: string[] = [];
  // The DB gives every row a source and an include_in_gl (default true);
  // fixtures say so only when the test is about one of them.
  const full = rows.map((r, i) => ({
    id: `b${i}`, chart_of_accounts_id: "coa-1", amount_cents: 100, transaction_date: "2026-06-01",
    mapping_source: "rule", source: "ramp", counterparty_key: null, counterparty_name: null, include_in_gl: true, ...r,
  }));

  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: (c: string, v: unknown) => { calls.push(`eq(${c},${String(v)})`); return chain; },
    or: (f: string) => { calls.push(`or(${f})`); return chain; },
    lte: () => chain,
    gte: () => chain,
    order: () => chain,
    range: async (from: number, to: number) => ({ data: full.slice(from, to + 1), error: null }),
  };

  const client = {
    calls,
    from(table: string) {
      if (table === "bank_ledger_gl_rules") return { select: async () => ({ data: glRules, error: null }) };
      return chain;
    },
  };
  return client as unknown as SupabaseClient & { calls: string[] };
}

describe("fetchBank", () => {
  it("builds the pre-existing query and keeps every row while no rule has been made", async () => {
    const client = fakeBankClient([{ id: "b0" }, { id: "b1" }]);
    const rows = await fetchBank(client, RANGE, "balance_sheet");
    expect(rows.map((r) => r.id)).toEqual(["b0", "b1"]);
    expect(client.calls).toContain("eq(include_in_gl,true)");
    expect(client.calls.some((c) => c.startsWith("or("))).toBe(false);
  });

  it("still drops the rows the importer excluded", async () => {
    const client = fakeBankClient([{ id: "b0" }, { id: "b1", source: "plaid", include_in_gl: false }]);
    const rows = await fetchBank(client, RANGE, "balance_sheet");
    expect(rows.map((r) => r.id)).toEqual(["b0"]);
  });

  it("widens the query and keeps the rows once a feed is switched on", async () => {
    const client = fakeBankClient(
      [{ id: "b0" }, { id: "b1", source: "plaid", include_in_gl: false }],
      [{ scope: "source", source: "plaid", counterparty_key: null, included: true }],
    );
    const rows = await fetchBank(client, RANGE, "balance_sheet");
    expect(rows.map((r) => r.id)).toEqual(["b0", "b1"]);
    expect(client.calls).toContain("or(include_in_gl.eq.true,source.in.(plaid))");
  });

  it("drops a counterparty switched out of the books", async () => {
    const client = fakeBankClient(
      [{ id: "b0", counterparty_key: "gusto" }, { id: "b1", counterparty_name: "TPB OPERATING FUNDS (···· 4077)" }],
      [{ scope: "counterparty", source: "ramp", counterparty_key: "tpb operating funds (···· 4077)", included: false }],
    );
    const rows = await fetchBank(client, RANGE, "balance_sheet");
    expect(rows.map((r) => r.id)).toEqual(["b0"]);
  });

  it("keeps the P&L's own affects_pl predicate alongside the rules", async () => {
    const client = fakeBankClient([{ id: "b0" }]);
    await fetchBank(client, RANGE, "pl");
    expect(client.calls).toContain("eq(affects_pl,true)");
  });
});

// Covers fetchExpenses's expense_gl_splits + payroll-period batch-joins and
// fetchInvoiceLines's channel-derivation fallback in isolation (the rest of
// fetchFinancialsSources's per-source fetches are exercised indirectly via
// buildFinancials.test.ts, which mocks fetchFinancialsSources wholesale).
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchExpenses, fetchInvoiceLines, fetchTipAccruals, fetchTaxAccruals } from "./fetchSources";

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

// ── fetchTipAccruals ─────────────────────────────────────────────────────

interface SquareOrderTipRow {
  tip_cents: number | null;
  invoice_id: string | null;
  status?: string;
}

/**
 * Fake `square_orders` client. Applies the `.is("invoice_id", null)` and
 * `.eq("status", "COMPLETED")` filters itself (mirroring how the real query
 * excludes invoice-backed and non-completed orders) so tests can assert
 * exclusion behavior, not just the raw sum.
 */
function fakeSquareOrdersClient(rows: SquareOrderTipRow[]) {
  let filteredByNullInvoiceId = false;
  let filteredByStatus: string | null = null;
  const chain: Record<string, unknown> = {
    select: () => chain,
    is: (col: string, val: unknown) => {
      if (col === "invoice_id" && val === null) filteredByNullInvoiceId = true;
      return chain;
    },
    eq: (col: string, val: unknown) => {
      if (col === "status") filteredByStatus = val as string;
      return chain;
    },
    lt: () => chain,
    gte: () => chain,
    order: () => chain,
    range: async (from: number, to: number) => {
      let data = rows;
      if (filteredByNullInvoiceId) data = data.filter((r) => r.invoice_id === null);
      if (filteredByStatus) data = data.filter((r) => r.status === filteredByStatus);
      return { data: data.slice(from, to + 1), error: null };
    },
  };
  const client = { from: () => chain };
  return client as unknown as SupabaseClient;
}

const TIP_RANGE = { startDateStr: null, start: null, endDateStr: "2026-01-31", end: "2026-02-01T00:00:00Z" };

describe("fetchTipAccruals", () => {
  it("sums tip_cents across orders in range into one canonical-month record", async () => {
    const client = fakeSquareOrdersClient([
      { tip_cents: 500, invoice_id: null, status: "COMPLETED" },
      { tip_cents: 300, invoice_id: null, status: "COMPLETED" },
    ]);

    const result = await fetchTipAccruals(client, TIP_RANGE, "acct-tips");

    expect(result).toEqual([{ id: "tips-2026-01", chartOfAccountsId: "acct-tips", amountCents: 800, monthKey: "2026-01" }]);
  });

  it("excludes rows with a non-null invoice_id", async () => {
    const client = fakeSquareOrdersClient([
      { tip_cents: 500, invoice_id: null, status: "COMPLETED" },
      { tip_cents: 9999, invoice_id: "inv-1", status: "COMPLETED" },
    ]);

    const result = await fetchTipAccruals(client, TIP_RANGE, "acct-tips");

    expect(result[0].amountCents).toBe(500);
  });

  // syncPosTransactions.ts keeps a CANCELED order's header tip_cents intact
  // and only withdraws its line items, so this is the one financials source
  // that isn't immune to canceled orders without an explicit status filter.
  it("excludes rows whose status is not COMPLETED (e.g. CANCELED)", async () => {
    const client = fakeSquareOrdersClient([
      { tip_cents: 500, invoice_id: null, status: "COMPLETED" },
      { tip_cents: 9999, invoice_id: null, status: "CANCELED" },
    ]);

    const result = await fetchTipAccruals(client, TIP_RANGE, "acct-tips");

    expect(result[0].amountCents).toBe(500);
  });

  it("returns [] when tipsAccountId is null, without querying the database", async () => {
    const client = {
      from: () => {
        throw new Error("fetchTipAccruals must not query when tipsAccountId is null");
      },
    } as unknown as SupabaseClient;

    const result = await fetchTipAccruals(client, TIP_RANGE, null);

    expect(result).toEqual([]);
  });

  it("returns [] when the summed tips are 0 (degenerate accrual guard)", async () => {
    const client = fakeSquareOrdersClient([
      { tip_cents: 0, invoice_id: null, status: "COMPLETED" },
      { tip_cents: null, invoice_id: null, status: "COMPLETED" },
    ]);

    const result = await fetchTipAccruals(client, TIP_RANGE, "acct-tips");

    expect(result).toEqual([]);
  });

  it("pages past 1000 rows (PostgREST silently truncates unpaginated selects)", async () => {
    const firstPage: SquareOrderTipRow[] = Array.from({ length: 1000 }, () => ({ tip_cents: 1, invoice_id: null, status: "COMPLETED" }));
    const secondPage: SquareOrderTipRow[] = [{ tip_cents: 50, invoice_id: null, status: "COMPLETED" }];
    const client = fakeSquareOrdersClient([...firstPage, ...secondPage]);

    const result = await fetchTipAccruals(client, TIP_RANGE, "acct-tips");

    // 1000 x 1 cent from the first page + 50 cents from the second page --
    // only reachable if fetchAllRows actually paged past the 1000-row cap.
    expect(result[0].amountCents).toBe(1050);
  });
});

describe("fetchTaxAccruals", () => {
  const range = { startDateStr: null, start: null, endDateStr: "2026-07-31", end: "2026-08-01T00:00:00Z" };

  function stub(posRows: unknown[], invRows: unknown[], invThrows = false) {
    const from = (table: string) => {
      if (table === "invoice_line_item_taxes" && invThrows) throw new Error('relation "invoice_line_item_taxes" does not exist');
      const b: Record<string, unknown> = {};
      b.select = () => b; b.eq = () => b; b.neq = () => b;
      b.gte = () => b; b.lt = () => b; b.lte = () => b; b.order = () => b;
      b.range = (f: number, t: number) => {
        const rows = table === "pos_line_item_taxes" ? posRows : invRows;
        return Promise.resolve({ data: rows.slice(f, t + 1), error: null });
      };
      return b;
    };
    return { from } as unknown as SupabaseClient;
  }

  const posRow = (id: string, taxId: string, cents: number) => ({
    line_item_id: id, square_tax_id: taxId, amount_cents: cents,
  });

  it("groups by square_tax_id, resolves accounts, and keys the canonical month", async () => {
    const sb = stub(
      [posRow("a", "TAX_GEN", 103243), posRow("b", "TAX_PFB", 8644), posRow("c", "TAX_GEN", 98095)],
      [],
    );
    const res = await fetchTaxAccruals(sb, range, new Map([["TAX_GEN", "COA_NCDOR"], ["TAX_PFB", "COA_WAKE"]]));
    expect(res).toEqual([
      { id: "tax-COA_NCDOR-2026-07", chartOfAccountsId: "COA_NCDOR", amountCents: 201338, monthKey: "2026-07" },
      { id: "tax-COA_WAKE-2026-07", chartOfAccountsId: "COA_WAKE", amountCents: 8644, monthKey: "2026-07" },
    ]);
  });

  it("merges two taxes that point at the same account", async () => {
    const sb = stub([posRow("a", "TAX_GEN", 100), posRow("b", "TAX_PFB", 25)], []);
    const res = await fetchTaxAccruals(sb, range, new Map([["TAX_GEN", "COA_X"], ["TAX_PFB", "COA_X"]]));
    expect(res).toEqual([{ id: "tax-COA_X-2026-07", chartOfAccountsId: "COA_X", amountCents: 125, monthKey: "2026-07" }]);
  });

  it("emits nothing for an unmapped tax", async () => {
    const sb = stub([posRow("a", "TAX_UNKNOWN", 500)], []);
    // Non-empty map on purpose: an empty map short-circuits before the
    // per-row mapping filter, so it would pass for the wrong reason.
    expect(await fetchTaxAccruals(sb, range, new Map([["TAX_GEN", "COA_X"]]))).toEqual([]);
  });

  it("emits nothing when no tax is mapped at all", async () => {
    const sb = stub([posRow("a", "TAX_GEN", 500)], []);
    expect(await fetchTaxAccruals(sb, range, new Map())).toEqual([]);
  });

  it("skips an account whose total is <= 0", async () => {
    const sb = stub([posRow("a", "TAX_GEN", 0)], []);
    expect(await fetchTaxAccruals(sb, range, new Map([["TAX_GEN", "COA_X"]]))).toEqual([]);
  });

  it("degrades to POS-only when the invoice tax table is missing", async () => {
    const sb = stub([posRow("a", "TAX_GEN", 700)], [], true);
    const res = await fetchTaxAccruals(sb, range, new Map([["TAX_GEN", "COA_X"]]));
    expect(res).toEqual([{ id: "tax-COA_X-2026-07", chartOfAccountsId: "COA_X", amountCents: 700, monthKey: "2026-07" }]);
  });

  it("propagates a non-missing-table error from the invoice tax fetch instead of silently zeroing it", async () => {
    const from = (table: string) => {
      if (table === "invoice_line_item_taxes") throw new Error("boom");
      const b: Record<string, unknown> = {};
      b.select = () => b; b.eq = () => b; b.neq = () => b;
      b.gte = () => b; b.lt = () => b; b.lte = () => b; b.order = () => b;
      b.range = (f: number, t: number) =>
        Promise.resolve({ data: [posRow("a", "TAX_GEN", 700)].slice(f, t + 1), error: null });
      return b;
    };
    const sb = { from } as unknown as SupabaseClient;
    await expect(fetchTaxAccruals(sb, range, new Map([["TAX_GEN", "COA_X"]]))).rejects.toThrow(/boom/);
  });
});

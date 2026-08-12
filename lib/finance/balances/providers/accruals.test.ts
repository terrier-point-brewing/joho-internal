// Assert the three moved providers reproduce their source fixtures'
// values -- lifted from lib/finance/financials/fetchSources.test.ts's
// fetchTipAccruals/fetchTaxAccruals cases -- so the move from fetchSources.ts
// to lib/finance/balances/providers/accruals.ts is provably behavior-
// preserving. openInvoiceAr's fixtures mirror buildFinancials.ts's
// injectOpenInvoiceAr guard (openInvoiceArCents <= 0 => skip).
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { openInvoiceAr, openBillAp, tipAccrual, taxAccrual } from "./accruals";
import type { BalanceContext } from "../registry";

function ctx(overrides: Partial<BalanceContext> & { supabase: SupabaseClient }): BalanceContext {
  return { periodEnd: "2026-01-31", coaId: "coa-1", config: {}, ...overrides };
}

// ── openInvoiceAr ────────────────────────────────────────────────────────

function fakeInvoicesClient(rows: { total_cents: number | null }[]) {
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    lte: () => chain,
    order: () => chain,
    range: async (from: number, to: number) => ({ data: rows.slice(from, to + 1), error: null }),
  };
  return { from: () => chain } as unknown as SupabaseClient;
}

describe("openInvoiceAr", () => {
  /**
   * The declaration that keeps this provider out of historical backfills.
   *
   * It filters on `status = 'open'`, a CURRENT status, and `invoices` carries
   * no payment date to reconstruct an as-at-March one from. Backfilling March
   * with it would count only the March invoices still unpaid today — plausible,
   * lower than the truth, and indistinguishable from a correct figure. Losing
   * this flag in a refactor would restore that silently, so it is asserted
   * rather than left to the comment beside it. See
   * `BalanceProvider.dependsOnCurrentState`.
   */
  it("declares that it can only answer about today", () => {
    expect(openInvoiceAr.dependsOnCurrentState).toBe(true);
  });

  it("sums total_cents of open invoices dated on or before periodEnd", async () => {
    const supabase = fakeInvoicesClient([{ total_cents: 10000 }, { total_cents: 2500 }]);

    const result = await openInvoiceAr.compute(ctx({ supabase }));

    expect(result).toBe(12500);
  });

  it("returns null (not 0) when there are none", async () => {
    const supabase = fakeInvoicesClient([]);

    const result = await openInvoiceAr.compute(ctx({ supabase }));

    expect(result).toBeNull();
  });

  it("is an asset (1100) -- no sign flip, magnitude passes through positive", async () => {
    const supabase = fakeInvoicesClient([{ total_cents: 500 }]);

    const result = await openInvoiceAr.compute(ctx({ supabase }));

    expect(result).toBe(500);
  });
});

// ── openBillAp ───────────────────────────────────────────────────────────

interface BillQuery {
  table: string;
  eq: [string, unknown][];
  lte: [string, unknown][];
  or: string[];
  is: [string, unknown][];
}

function fakeBillsClient(rows: { amount_cents: number | null }[]) {
  const seen: BillQuery = { table: "", eq: [], lte: [], or: [], is: [] };
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: (col: string, val: unknown) => { seen.eq.push([col, val]); return chain; },
    lte: (col: string, val: unknown) => { seen.lte.push([col, val]); return chain; },
    or: (filters: string) => { seen.or.push(filters); return chain; },
    is: (col: string, val: unknown) => { seen.is.push([col, val]); return chain; },
    filter: () => chain,
    order: () => chain,
    range: async (from: number, to: number) => ({ data: rows.slice(from, to + 1), error: null }),
  };
  const supabase = { from: (table: string) => { seen.table = table; return chain; } } as unknown as SupabaseClient;
  return { supabase, seen };
}

describe("openBillAp", () => {
  /**
   * The inverse of openInvoiceAr's assertion above, and the reason A/P is a
   * calculation while A/R can only answer for today.
   *
   * `expenses.state` would put this provider in exactly openInvoiceAr's
   * position: it is overwritten in place on every sync, so it says whether a
   * bill is owed NOW. `settled_at` is history rather than status -- Ramp's
   * immutable `paid_at`, persisted -- so "was this owed on the 30th of June" is
   * answerable from stored rows, and a closed month recomputes to the figure it
   * closed with. Setting this flag would quietly withdraw A/P from every month
   * but the open one, so the absence is asserted rather than assumed.
   */
  it("can answer about a past month, so it is NOT current-state-only", () => {
    expect(openBillAp.dependsOnCurrentState).toBeFalsy();
  });

  it("asks only for bills received by the month end and unpaid at it", async () => {
    const { supabase, seen } = fakeBillsClient([{ amount_cents: -63700 }]);

    await openBillAp.compute(ctx({ supabase, periodEnd: "2026-01-31" }));

    expect(seen.table).toBe("expenses");
    expect(seen.eq).toContainEqual(["ramp_object", "bill"]);
    expect(seen.lte).toContainEqual(["accounting_date", "2026-01-31"]);
    // Exclusive upper bound: a bill paid at 14:46 on the 31st was paid IN
    // January, so only settlements from February onwards leave it outstanding.
    expect(seen.or).toContain("settled_at.is.null,settled_at.gte.2026-02-01T00:00:00.000Z");
  });

  /**
   * A declined or manually excluded row is not a debt. Asserted here because
   * this provider builds its own query rather than going through
   * fetchExpenses, and the eligibility rule has to stay one rule -- see
   * financials/expenseFilters.ts, which is where it lives.
   */
  it("applies the shared statement eligibility filter on its accrual setting", async () => {
    const { supabase, seen } = fakeBillsClient([{ amount_cents: -100 }]);

    await openBillAp.compute(ctx({ supabase }));

    expect(seen.or).toContain("state.is.null,state.neq.DECLINED");
    expect(seen.is).toContainEqual(["excluded_at", null]);
  });

  it("sums the unpaid bill lines as a negative liability, with no second sign flip", async () => {
    // Bill amounts are stored signed by cash direction, so already negative.
    const { supabase } = fakeBillsClient([
      { amount_cents: -63700 }, { amount_cents: -38340 }, { amount_cents: -97148 },
    ]);

    const result = await openBillAp.compute(ctx({ supabase }));

    expect(result).toBe(-199188);
  });

  /**
   * The reason this returns the NET rather than a magnitude. A vendor credit
   * arrives positive; abs()-ing the sum would turn money the supplier owes back
   * into money owed to them, inflating the debt by twice the credit.
   */
  it("lets a vendor credit reduce the debt instead of inflating it", async () => {
    const { supabase } = fakeBillsClient([{ amount_cents: -50000 }, { amount_cents: 12000 }]);

    const result = await openBillAp.compute(ctx({ supabase }));

    expect(result).toBe(-38000);
  });

  /**
   * The single failure this layer exists to prevent, on the account where it
   * would be least visible. "Nothing is owed" and "the bill feed never ran"
   * produce the same empty row set, and a confident $0 on a payables account
   * reads as reconciled when it is only blind.
   */
  it("returns null, never 0, when it finds no bills at all", async () => {
    const { supabase } = fakeBillsClient([]);

    const result = await openBillAp.compute(ctx({ supabase }));

    expect(result).toBeNull();
  });

  /**
   * Zero is a real answer when there are rows to net: bills that cancel against
   * their credits genuinely leave nothing owed, and that is different from
   * having found nothing at all.
   */
  it("reports a genuine zero when the bills it found net out", async () => {
    const { supabase } = fakeBillsClient([{ amount_cents: -12000 }, { amount_cents: 12000 }]);

    const result = await openBillAp.compute(ctx({ supabase }));

    expect(result).toBe(0);
  });

  it("is offerable on GL 2000 and nowhere else", () => {
    expect(openBillAp.appliesTo?.({ accountNumber: "2000" } as never)).toBe(true);
    expect(openBillAp.appliesTo?.({ accountNumber: "1100" } as never)).toBe(false);
  });
});

// ── tipAccrual ───────────────────────────────────────────────────────────

interface SquareOrderTipRow {
  tip_cents: number | null;
  invoice_id: string | null;
  status?: string;
}

function fakeTipsClient(opts: { tipsAccountId: string | null; orders: SquareOrderTipRow[] }) {
  let filteredByNullInvoiceId = false;
  let filteredByStatus: string | null = null;
  const ordersChain: Record<string, unknown> = {
    select: () => ordersChain,
    is: (col: string, val: unknown) => {
      if (col === "invoice_id" && val === null) filteredByNullInvoiceId = true;
      return ordersChain;
    },
    eq: (col: string, val: unknown) => {
      if (col === "status") filteredByStatus = val as string;
      return ordersChain;
    },
    lt: () => ordersChain,
    gte: () => ordersChain,
    order: () => ordersChain,
    range: async (from: number, to: number) => {
      let data = opts.orders;
      if (filteredByNullInvoiceId) data = data.filter((r) => r.invoice_id === null);
      if (filteredByStatus) data = data.filter((r) => r.status === filteredByStatus);
      return { data: data.slice(from, to + 1), error: null };
    },
  };

  const settingsChain: Record<string, unknown> = {
    select: () => settingsChain,
    maybeSingle: async () => ({
      data: opts.tipsAccountId !== null ? { tips_chart_of_accounts_id: opts.tipsAccountId } : null,
      error: null,
    }),
  };

  return {
    from: (table: string) => {
      if (table === "square_orders") return ordersChain;
      if (table === "payroll_gl_settings") return settingsChain;
      throw new Error(`unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient;
}

/** payroll_gl_settings table missing entirely (migration 20260823 unapplied). */
function fakeTipsClientMissingSettingsTable() {
  return {
    from: (table: string) => {
      if (table === "payroll_gl_settings") {
        throw new Error('relation "payroll_gl_settings" does not exist');
      }
      throw new Error(`unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient;
}

describe("tipAccrual", () => {
  it("sums tip_cents for COMPLETED orders with invoice_id null through periodEnd, negated for the liability", async () => {
    const supabase = fakeTipsClient({
      tipsAccountId: "acct-tips",
      orders: [
        { tip_cents: 500, invoice_id: null, status: "COMPLETED" },
        { tip_cents: 300, invoice_id: null, status: "COMPLETED" },
      ],
    });

    const result = await tipAccrual.compute(ctx({ supabase }));

    expect(result).toBe(-800);
  });

  it("excludes rows whose status is not COMPLETED (e.g. CANCELED) -- the load-bearing filter", async () => {
    // syncPosTransactions.ts keeps a CANCELED order's header tip_cents intact
    // and only withdraws its line items, so dropping this filter would
    // silently inflate the liability.
    const supabase = fakeTipsClient({
      tipsAccountId: "acct-tips",
      orders: [
        { tip_cents: 500, invoice_id: null, status: "COMPLETED" },
        { tip_cents: 9999, invoice_id: null, status: "CANCELED" },
      ],
    });

    const result = await tipAccrual.compute(ctx({ supabase }));

    expect(result).toBe(-500);
  });

  it("excludes rows with a non-null invoice_id", async () => {
    const supabase = fakeTipsClient({
      tipsAccountId: "acct-tips",
      orders: [
        { tip_cents: 500, invoice_id: null, status: "COMPLETED" },
        { tip_cents: 9999, invoice_id: "inv-1", status: "COMPLETED" },
      ],
    });

    const result = await tipAccrual.compute(ctx({ supabase }));

    expect(result).toBe(-500);
  });

  it("returns null when the configured tips account is absent", async () => {
    const supabase = fakeTipsClient({ tipsAccountId: null, orders: [] });

    const result = await tipAccrual.compute(ctx({ supabase }));

    expect(result).toBeNull();
  });

  it("returns null when a missing payroll_gl_settings table is queried (unapplied migration 20260823)", async () => {
    const supabase = fakeTipsClientMissingSettingsTable();

    const result = await tipAccrual.compute(ctx({ supabase }));

    expect(result).toBeNull();
  });

  it("returns null when the summed tips are <= 0 (degenerate accrual guard)", async () => {
    const supabase = fakeTipsClient({
      tipsAccountId: "acct-tips",
      orders: [
        { tip_cents: 0, invoice_id: null, status: "COMPLETED" },
        { tip_cents: null, invoice_id: null, status: "COMPLETED" },
      ],
    });

    const result = await tipAccrual.compute(ctx({ supabase }));

    expect(result).toBeNull();
  });
});

// ── taxAccrual ───────────────────────────────────────────────────────────

function fakeTaxClient(opts: {
  taxAccounts: { square_tax_id: string; chart_of_accounts_id: string | null }[] | "missing-table";
  posRows: { square_tax_id: string; amount_cents: number | null }[];
  invRows: { square_tax_id: string; amount_cents: number | null }[];
  invThrows?: boolean;
}) {
  const posChain: Record<string, unknown> = {
    select: () => posChain,
    eq: () => posChain,
    lt: () => posChain,
    gte: () => posChain,
    order: () => posChain,
    range: async (from: number, to: number) => ({ data: opts.posRows.slice(from, to + 1), error: null }),
  };
  const invChain: Record<string, unknown> = {
    select: () => invChain,
    neq: () => invChain,
    lte: () => invChain,
    gte: () => invChain,
    order: () => invChain,
    range: async (from: number, to: number) => ({ data: opts.invRows.slice(from, to + 1), error: null }),
  };
  const taxAccountsChain: Record<string, unknown> = {
    select: () => taxAccountsChain,
    order: () => taxAccountsChain,
    range: async (from: number, to: number) => {
      const rows = opts.taxAccounts === "missing-table" ? [] : opts.taxAccounts;
      return { data: rows.slice(from, to + 1), error: null };
    },
  };

  return {
    from: (table: string) => {
      if (table === "square_tax_accounts") {
        if (opts.taxAccounts === "missing-table") throw new Error('relation "square_tax_accounts" does not exist');
        return taxAccountsChain;
      }
      if (table === "pos_line_item_taxes") return posChain;
      if (table === "invoice_line_item_taxes") {
        if (opts.invThrows) throw new Error('relation "invoice_line_item_taxes" does not exist');
        return invChain;
      }
      throw new Error(`unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient;
}

describe("taxAccrual", () => {
  it("unions POS and invoice line-item taxes, groups by mapped account, negated for the liability", async () => {
    const supabase = fakeTaxClient({
      taxAccounts: [{ square_tax_id: "TAX_GEN", chart_of_accounts_id: "coa-1" }],
      posRows: [
        { square_tax_id: "TAX_GEN", amount_cents: 500 },
        { square_tax_id: "TAX_GEN", amount_cents: 300 },
      ],
      invRows: [{ square_tax_id: "TAX_GEN", amount_cents: 200 }],
    });

    const result = await taxAccrual.compute(ctx({ supabase, coaId: "coa-1" }));

    expect(result).toBe(-1000);
  });

  it("returns null when square_tax_accounts is empty", async () => {
    const supabase = fakeTaxClient({ taxAccounts: [], posRows: [{ square_tax_id: "TAX_GEN", amount_cents: 500 }], invRows: [] });

    const result = await taxAccrual.compute(ctx({ supabase, coaId: "coa-1" }));

    expect(result).toBeNull();
  });

  it("returns null when a missing square_tax_accounts table is queried (simulated missing table)", async () => {
    const supabase = fakeTaxClient({ taxAccounts: "missing-table", posRows: [], invRows: [] });

    const result = await taxAccrual.compute(ctx({ supabase, coaId: "coa-1" }));

    expect(result).toBeNull();
  });

  it("returns null for an account with no collected tax", async () => {
    const supabase = fakeTaxClient({
      taxAccounts: [{ square_tax_id: "TAX_GEN", chart_of_accounts_id: "coa-1" }],
      posRows: [],
      invRows: [],
    });

    const result = await taxAccrual.compute(ctx({ supabase, coaId: "coa-1" }));

    expect(result).toBeNull();
  });

  it("degrades to POS-only when the invoice tax table is missing", async () => {
    const supabase = fakeTaxClient({
      taxAccounts: [{ square_tax_id: "TAX_GEN", chart_of_accounts_id: "coa-1" }],
      posRows: [{ square_tax_id: "TAX_GEN", amount_cents: 700 }],
      invRows: [],
      invThrows: true,
    });

    const result = await taxAccrual.compute(ctx({ supabase, coaId: "coa-1" }));

    expect(result).toBe(-700);
  });
});

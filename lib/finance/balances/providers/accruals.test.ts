// Assert the three moved providers reproduce their source fixtures'
// values -- lifted from lib/finance/financials/fetchSources.test.ts's
// fetchTipAccruals/fetchTaxAccruals cases -- so the move from fetchSources.ts
// to lib/finance/balances/providers/accruals.ts is provably behavior-
// preserving. openInvoiceAr's fixtures mirror buildFinancials.ts's
// injectOpenInvoiceAr guard (openInvoiceArCents <= 0 => skip).
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { openInvoiceAr, tipAccrual, taxAccrual } from "./accruals";
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

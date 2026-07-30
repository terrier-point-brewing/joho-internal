// Sums sign-normalized amounts from pos_line_items/invoice_line_items/
// expenses/ramp_bank_ledger rows directly tagged to a BS account, using the
// real normalizeSignedCents so the sign math can't drift from the
// consolidated-financials aggregation path it replaces. A generic
// table->rows fake stands in for Supabase; per-source filter correctness
// (date bounds, chart_of_accounts_id matching) is already covered by
// fetchSources.test.ts, so fixtures here only need to exercise this
// provider's own aggregation/guard logic.
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { transactionPostings } from "./transactionPostings";
import type { BalanceContext } from "../registry";

interface CoaRow {
  id: string;
  parent_id: string | null;
  account_name: string;
  account_number: string | null;
  account_type: string;
  statement_section: string | null;
}

function fakeClient(opts: {
  coa: CoaRow | null;
  posRows?: { net_sales_cents: number | null }[];
  invoiceRows?: { total_cents: number | null }[];
  expenseRows?: { amount_cents: number | null }[];
  bankRows?: { amount_cents: number | null }[];
}): SupabaseClient {
  const paginated = (rows: unknown[]) => {
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      lt: () => chain,
      lte: () => chain,
      order: () => chain,
      range: async (from: number, to: number) => ({ data: rows.slice(from, to + 1), error: null }),
    };
    return chain;
  };

  return {
    from: (table: string) => {
      if (table === "chart_of_accounts") {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: async () => ({ data: opts.coa, error: null }),
        };
        return chain;
      }
      if (table === "pos_line_items") return paginated(opts.posRows ?? []);
      if (table === "invoice_line_items") return paginated(opts.invoiceRows ?? []);
      if (table === "expenses") return paginated(opts.expenseRows ?? []);
      if (table === "ramp_bank_ledger") return paginated(opts.bankRows ?? []);
      throw new Error(`unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient;
}

const LIABILITY_COA: CoaRow = {
  id: "coa-2220",
  parent_id: null,
  account_name: "Sales Tax Payable",
  account_number: "2220",
  account_type: "Other Current Liabilities",
  statement_section: null,
};

function ctx(supabase: SupabaseClient, coaId = "coa-2220", periodEnd = "2026-01-31"): BalanceContext {
  return { supabase, coaId, periodEnd, config: {} };
}

describe("transactionPostings", () => {
  it("sums sign-normalized amounts across all four sources for a liability account", async () => {
    const supabase = fakeClient({
      coa: LIABILITY_COA,
      posRows: [{ net_sales_cents: 100 }],
      invoiceRows: [{ total_cents: 200 }],
      expenseRows: [{ amount_cents: -50 }],
      bankRows: [{ amount_cents: -30 }],
    });

    const result = await transactionPostings.compute(ctx(supabase));

    // pos: -100 (magnitude, liability section flips sign)
    // invoice: -200 (same)
    // expense: -(-50) = 50 (BS section flips cash-direction sign)
    // bank: -(-30) = 30 (same)
    // total: -100 - 200 + 50 + 30 = -220
    expect(result).toBe(-220);
  });

  it("returns null when the account row can't be found", async () => {
    const supabase = fakeClient({ coa: null });

    const result = await transactionPostings.compute(ctx(supabase));

    expect(result).toBeNull();
  });

  it("returns null when no rows match across any source", async () => {
    const supabase = fakeClient({ coa: LIABILITY_COA });

    const result = await transactionPostings.compute(ctx(supabase));

    expect(result).toBeNull();
  });
});

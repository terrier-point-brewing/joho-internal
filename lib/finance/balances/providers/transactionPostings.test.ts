// Sums sign-normalized amounts from pos_line_items/invoice_line_items/
// expenses/bank_ledger rows directly tagged to a BS account, using the
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
  splitRows?: { amount_cents: number | null }[];
  /** expense_gl_splits rows returned to sumExpenses' precedence probe (select "expense_id"). */
  splitParents?: { expense_id: string }[];
  /** Records every filter call, so a test can assert a filter is actually applied. */
  calls?: string[];
  refundRows?: { amount_cents: number | null }[];
  /** Partial rows; the inclusion columns default to what an ordinary Ramp row carries. Each is given an id "b0", "b1", … for the split fixtures below to point at. */
  bankRows?: ({ amount_cents: number | null } & Partial<{ source: string; counterparty_key: string | null; counterparty_name: string | null; include_in_gl: boolean }>)[];
  /** bank_ledger_gl_splits rows. Serves BOTH queries against that table — sumBank's precedence probe reads only bank_ledger_id, sumBankSplits reads the amount too. */
  bankSplitRows?: { bank_ledger_id: string; amount_cents: number | null }[];
  /** manual_entries rows of kind "flow" — a movement somebody typed. */
  manualRows?: { id: string; start_date: string | null; end_date: string | null; amount_cents: number | null }[];
  /** Rows of bank_ledger_gl_rules — the operator's standing decisions. Empty is the production state. */
  glRules?: { scope: string; source: string; counterparty_key: string | null; included: boolean }[];
}): SupabaseClient {
  const rec = (m: string, a: unknown[]) => opts.calls?.push(`${m}(${a.map(String).join(",")})`);
  const paginated = (rows: unknown[], table = "") => {
    const chain: Record<string, unknown> = {
      select: (...a: unknown[]) => { rec(`${table}.select`, a); return chain; },
      eq: (...a: unknown[]) => { rec(`${table}.eq`, a); return chain; },
      is: (...a: unknown[]) => { rec(`${table}.is`, a); return chain; },
      or: (...a: unknown[]) => { rec(`${table}.or`, a); return chain; },
      neq: (...a: unknown[]) => { rec(`${table}.neq`, a); return chain; },
      in: (...a: unknown[]) => { rec(`${table}.in`, a); return chain; },
      lt: (...a: unknown[]) => { rec(`${table}.lt`, a); return chain; },
      lte: (...a: unknown[]) => { rec(`${table}.lte`, a); return chain; },
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
      if (table === "pos_line_items") return paginated(opts.posRows ?? [], table);
      if (table === "invoice_line_items") return paginated(opts.invoiceRows ?? [], table);
      if (table === "expenses") return paginated((opts.expenseRows ?? []).map((r, i) => ({ id: `e${i}`, ...r })), table);
      if (table === "expense_gl_splits") {
        // Two different queries hit this table: sumExpenses' precedence probe
        // (selects expense_id) and sumExpenseSplits (selects amount_cents).
        const chain = paginated(opts.splitRows ?? [], table) as Record<string, unknown>;
        const origSelect = chain.select as (...a: unknown[]) => unknown;
        chain.select = (...a: unknown[]) => {
          origSelect(...a);
          return String(a[0]).includes("expense_id")
            ? paginated(opts.splitParents ?? [], table)
            : chain;
        };
        return chain;
      }
      if (table === "square_refunds") return paginated(opts.refundRows ?? [], table);
      if (table === "manual_entries") return paginated(opts.manualRows ?? [], table);
      if (table === "bank_ledger") {
        // The DB gives every row a source and an include_in_gl (default true);
        // fixtures say so only when the test is about one of them.
        //
        // Both bank_ledger queries are served the same rows: sumBank's own
        // fetch, and sumBankSplits' re-check of the PARENTS its allocation rows
        // name. That is faithful — the second is the first's inclusion gate
        // applied to a narrower id list, and this fake ignores .in() anyway.
        return paginated(
          (opts.bankRows ?? []).map((r, i) => ({ id: `b${i}`, source: "ramp", counterparty_key: null, counterparty_name: null, include_in_gl: true, ...r })),
          table,
        );
      }
      if (table === "bank_ledger_gl_splits") return paginated(opts.bankSplitRows ?? [], table);
      if (table === "bank_ledger_gl_rules") {
        const chain: Record<string, unknown> = { select: async () => ({ data: opts.glRules ?? [], error: null }) };
        return chain;
      }
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
  it("sums sign-normalized amounts across all six sources for a liability account", async () => {
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

describe("transactionPostings — sources that are easy to forget", () => {
  // expense_gl_splits: a split expense's OWN chart_of_accounts_id is NULL by
  // design, so an account funded entirely by splits reads $0 without this.
  // GL 1310 Security Deposits Paid is exactly that account in production.
  it("counts expense_gl_splits, which the parent expense can never match on", async () => {
    const supabase = fakeClient({ coa: LIABILITY_COA, splitRows: [{ amount_cents: -312000 }] });
    // liability section + expense source => normalizeSignedCents flips the sign
    expect(await transactionPostings.compute(ctx(supabase))).toBe(312000);
  });

  it("counts square_refunds, as a SETTLEMENT on a liability account", async () => {
    const supabase = fakeClient({ coa: LIABILITY_COA, refundRows: [{ amount_cents: 5000 }] });
    // This used to assert -5000, on normalizeSign's old "a refund is always
    // contra-revenue regardless of section" rule. That rule is still in force
    // for every P&L account and no longer holds here.
    //
    // GL 2420 Equipment Deposits is why. Its Keg and Pump Deposit POS items
    // credit the liability when a deposit is taken (-5000), so handing the
    // deposit back has to DEBIT it. Under the old sign the settlement grew the
    // liability it was settling, and 2420 could only ever climb — which is what
    // it had been doing in production, with a returned pump still on the books.
    // See refundRouting.ts, which is what actually routes a deposit refund here.
    expect(await transactionPostings.compute(ctx(supabase))).toBe(5000);
  });

  it("still returns null when every one of the six sources is empty", async () => {
    expect(await transactionPostings.compute(ctx(fakeClient({ coa: LIABILITY_COA })))).toBeNull();
  });
});

// Regression guards for the four query filters. Before these, every chain
// method on the fake was an identity no-op, so deleting any of the filters
// left the suite fully green — the fixes had no artefact defending them.
describe("transactionPostings — the filters are actually applied", () => {
  async function callsFor(o: Parameters<typeof fakeClient>[0] = { coa: LIABILITY_COA }) {
    const calls: string[] = [];
    await transactionPostings.compute(ctx(fakeClient({ ...o, calls })));
    return calls;
  }

  it("excludes voided invoices — without this, GL 2430 invents $6,459.48", async () => {
    const calls = await callsFor({ coa: LIABILITY_COA, invoiceRows: [{ total_cents: 1 }] });
    expect(calls).toContain("invoice_line_items.neq(invoices.status,voided)");
  });

  it("applies the DECLINED/excluded expense filters", async () => {
    const calls = await callsFor({ coa: LIABILITY_COA, expenseRows: [{ amount_cents: -1 }] });
    expect(calls.some((c) => c.startsWith("expenses.or(state.is.null,state.neq.DECLINED"))).toBe(true);
    expect(calls).toContain("expenses.is(excluded_at,null)");
  });

  it("filters refunds to COMPLETED", async () => {
    const calls = await callsFor({ coa: LIABILITY_COA, refundRows: [{ amount_cents: 1 }] });
    expect(calls).toContain("square_refunds.eq(status,COMPLETED)");
  });

  it("applies the split parent's state/excluded filters against the embedded expense", async () => {
    const calls = await callsFor({ coa: LIABILITY_COA, splitRows: [{ amount_cents: -1 }] });
    expect(calls).toContain("expense_gl_splits.is(expenses.excluded_at,null)");
  });

  it("counts only bank lines the ledger includes in the general ledger", async () => {
    // bank_ledger carries more than one source now. Plaid's Chase rows are
    // imported with include_in_gl false, because they exist so a Square transfer
    // can be recognised from the receiving side, not as postings. Without this
    // predicate they would land in this sum and change the reported balance of
    // every account they touch, across up to two years of imported history,
    // with nothing on screen to say so.
    //
    // Existing Ramp rows default to true, so adding the filter changes no
    // figure that was ever reported.
    const calls = await callsFor({ coa: LIABILITY_COA, bankRows: [{ amount_cents: -1 }] });
    expect(calls).toContain("bank_ledger.eq(include_in_gl,true)");
  });
});

/**
 * The operator's standing rules about bank feeds and counterparties.
 *
 * This provider feeds the balance sheet, so the property that has to hold is
 * that a rule table nobody has written to leaves every figure exactly where it
 * was -- same query, same rows, same sum. Only a decision somebody made can move
 * one, which is also the whole point of the feature.
 */
describe("transactionPostings — bank-feed and counterparty rules", () => {
  it("changes neither the query nor the sum while nobody has decided anything", async () => {
    const calls: string[] = [];
    const supabase = fakeClient({ coa: LIABILITY_COA, bankRows: [{ amount_cents: -30 }], glRules: [], calls });
    expect(await transactionPostings.compute(ctx(supabase))).toBe(30);
    expect(calls).toContain("bank_ledger.eq(include_in_gl,true)");
    expect(calls.some((c) => c.startsWith("bank_ledger.or("))).toBe(false);
  });

  it("counts a feed somebody switched on, despite the importer having excluded its rows", async () => {
    const supabase = fakeClient({
      coa: LIABILITY_COA,
      bankRows: [{ amount_cents: -30, source: "plaid", include_in_gl: false }],
      glRules: [{ scope: "source", source: "plaid", counterparty_key: null, included: true }],
    });
    expect(await transactionPostings.compute(ctx(supabase))).toBe(30);
  });

  it("drops a counterparty somebody switched out of the books", async () => {
    // The live case: transfers in from the business's own other account, which
    // moved the bank balance but are neither income nor expense.
    const supabase = fakeClient({
      coa: LIABILITY_COA,
      bankRows: [
        { amount_cents: -30, counterparty_key: "gusto" },
        { amount_cents: -70, counterparty_key: "tpb operating funds (···· 4077)" },
      ],
      glRules: [{ scope: "counterparty", source: "ramp", counterparty_key: "tpb operating funds (···· 4077)", included: false }],
    });
    expect(await transactionPostings.compute(ctx(supabase))).toBe(30);
  });

  it("returns null rather than zero when every bank row was ruled out and nothing else posts", async () => {
    // An account with no contribution must produce NO figure at all, not a
    // confident $0 -- the excluded rows must not be counted as rows either.
    const supabase = fakeClient({
      coa: LIABILITY_COA,
      bankRows: [{ amount_cents: -30, counterparty_key: "gusto" }],
      glRules: [{ scope: "counterparty", source: "ramp", counterparty_key: "gusto", included: false }],
    });
    expect(await transactionPostings.compute(ctx(supabase))).toBe(null);
  });
});

describe("transactionPostings — split precedence", () => {
  // Splits REPLACE the parent's own account; they do not add to it. The parent
  // keeps its chart_of_accounts_id when split (the splits route pins only
  // mapping_source), so counting both double-counts real money.
  it("drops a parent expense that has split lines", async () => {
    const supabase = fakeClient({
      coa: LIABILITY_COA,
      expenseRows: [{ amount_cents: -1000000 }], // becomes id "e0"
      splitParents: [{ expense_id: "e0" }],
      splitRows: [{ amount_cents: -300000 }],
    });
    // Only the split contributes: 300000, not 300000 + 1000000.
    expect(await transactionPostings.compute(ctx(supabase))).toBe(300000);
  });

  it("keeps a parent expense that has no splits", async () => {
    const supabase = fakeClient({
      coa: LIABILITY_COA,
      expenseRows: [{ amount_cents: -1000000 }],
      splitParents: [],
    });
    expect(await transactionPostings.compute(ctx(supabase))).toBe(1000000);
  });
});

// ── Manual entries ───────────────────────────────────────────────────────────
// A "flow" entry is a movement somebody typed, and postings counts it beside
// the ones the feeds delivered. This is the seam between the two methods: this
// one listens to everything and chases nobody; manual entry listens only to the
// operator and chases them every month.

describe("transactionPostings — manual entries", () => {
  const ASSET_COA: CoaRow = {
    id: "coa-1520",
    parent_id: null,
    account_name: "Brewery Machinery & Equipment",
    account_number: "1520",
    account_type: "Fixed Assets",
    statement_section: null,
  };

  function assetCtx(supabase: SupabaseClient, periodEnd: string) {
    return ctx(supabase, "coa-1520", periodEnd);
  }

  it("counts a typed movement, letting an account with no feed activity report a real balance", async () => {
    const supabase = fakeClient({
      coa: ASSET_COA,
      manualRows: [{ id: "m1", start_date: "2026-06-01", end_date: "2026-06-30", amount_cents: 250_000_00 }],
    });

    expect(await transactionPostings.compute(assetCtx(supabase, "2026-07-31"))).toBe(250_000_00);
  });

  it("adds typed movements to the ones the feeds delivered", async () => {
    const supabase = fakeClient({
      coa: ASSET_COA,
      manualRows: [{ id: "m1", start_date: "2026-06-01", end_date: "2026-06-30", amount_cents: 250_000_00 }],
      // A later equipment purchase, arriving as an ordinary outflow. On a
      // balance-sheet section normalizeSignedCents reads an asset-purchase
      // outflow as a positive asset movement.
      bankRows: [{ amount_cents: -12_000_00 }],
    });

    expect(await transactionPostings.compute(assetCtx(supabase, "2026-07-31"))).toBe(262_000_00);
  });

  it("passes the operator's sign through rather than re-deriving it", async () => {
    // A negative flow is a legitimate correction, and a contra account's
    // entries are stored negative. Running these through the section's sign
    // rule would flip a deliberate credit into a debit.
    const supabase = fakeClient({
      coa: ASSET_COA,
      manualRows: [{ id: "m1", start_date: "2026-06-01", end_date: "2026-06-30", amount_cents: -4_000_00 }],
    });

    expect(await transactionPostings.compute(assetCtx(supabase, "2026-07-31"))).toBe(-4_000_00);
  });

  it("prorates an entry spanning several months, counting only the part that has happened", async () => {
    // 90 days at $900 total, asked about the end of the first month: 30 of 90
    // days have elapsed, so a third of it has.
    const supabase = fakeClient({
      coa: ASSET_COA,
      manualRows: [{ id: "m1", start_date: "2026-06-01", end_date: "2026-08-29", amount_cents: 900_00 }],
    });

    expect(await transactionPostings.compute(assetCtx(supabase, "2026-06-30"))).toBe(300_00);
  });

  it("ignores a balance entry — a stated position is the manual method's input, not a movement", async () => {
    const calls: string[] = [];
    const supabase = fakeClient({ coa: ASSET_COA, calls });

    await transactionPostings.compute(assetCtx(supabase, "2026-07-31"));

    // Adding a position to a running total of movements would count everything
    // the position already contains a second time.
    expect(calls).toContain("manual_entries.eq(entry_kind,flow)");
  });

  it("still reports an account with nothing at all as unsourced, not as zero", async () => {
    const supabase = fakeClient({ coa: ASSET_COA });

    expect(await transactionPostings.compute(assetCtx(supabase, "2026-07-31"))).toBeNull();
  });
});

/**
 * One bank line divided across several balance-sheet accounts.
 *
 * The transaction these exist for is the 2026-04-21 acquisition wire: $400,625
 * leaves the operating account once and arrives as four classes of asset. The
 * allocation is the coding, so it must post — and the parent must not post
 * again beside it.
 */
describe("transactionPostings — bank-ledger splits", () => {
  const ASSET_COA: CoaRow = {
    id: "coa-1520",
    parent_id: null,
    account_name: "Brewery Machinery & Equipment",
    account_number: "1520",
    account_type: "Fixed Assets",
    statement_section: null,
  };

  it("posts the allocation and not the line it came from", async () => {
    const supabase = fakeClient({
      coa: ASSET_COA,
      // The wire, an outflow, which this fake hands to sumBank as if it were
      // coded to 1520 — the state the split route in fact clears. If the
      // precedence filter were missing, this row would post $400,625 of its own
      // on top of the allocation below.
      bankRows: [{ amount_cents: -400_625_00 }],
      bankSplitRows: [{ bank_ledger_id: "b0", amount_cents: -300_000_00 }],
    });

    // Fixed assets is a balance-sheet section, so the cash-direction sign flips:
    // money out buys an asset. $300,000 of machinery, and nothing from the parent.
    expect(await transactionPostings.compute(ctx(supabase, "coa-1520"))).toBe(300_000_00);
  });

  it("does not let a split smuggle a line past a feed that is switched off", async () => {
    // Plaid rows are imported excluded, and the operator has made no rule. The
    // allocation's parent therefore fails the same gate sumBank applies to it,
    // and an allocation whose parent nobody counts contributes nothing.
    const supabase = fakeClient({
      coa: ASSET_COA,
      bankRows: [{ amount_cents: -400_625_00, source: "plaid", include_in_gl: false }],
      bankSplitRows: [{ bank_ledger_id: "b0", amount_cents: -300_000_00 }],
    });

    expect(await transactionPostings.compute(ctx(supabase, "coa-1520"))).toBeNull();
  });

  it("counts every slice landing on the same account", async () => {
    const supabase = fakeClient({
      coa: ASSET_COA,
      bankRows: [{ amount_cents: -400_625_00 }],
      bankSplitRows: [
        { bank_ledger_id: "b0", amount_cents: -300_000_00 },
        { bank_ledger_id: "b0", amount_cents: -25_000_00 },
      ],
    });

    expect(await transactionPostings.compute(ctx(supabase, "coa-1520"))).toBe(325_000_00);
  });
});

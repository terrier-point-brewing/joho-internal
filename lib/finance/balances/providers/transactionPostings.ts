// The general-purpose provider: sums sign-normalized amounts from
// pos_line_items, invoice_line_items, expenses and ramp_bank_ledger rows
// DIRECTLY tagged to a balance-sheet account's chart_of_accounts_id (no
// catalog-prefill fallback -- that's a P&L-page convenience, not a posted
// GL fact), dated on or before periodEnd. Reuses normalizeSignedCents (the
// exact function the consolidated-financials aggregation path uses) so this
// provider cannot drift from it.

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { normalizeSignedCents } from "@/lib/finance/financials/normalizeSign";
import { coaSection } from "@/lib/finance/financials/aggregateRows";
import { applyExpenseStatementFilters } from "@/lib/finance/financials/expenseFilters";
import type { CoaRecord } from "@/lib/finance/financials/aggregateRows";
import { registerProvider } from "../registry";
import type { BalanceContext, BalanceProvider } from "../registry";

/** Exclusive upper bound: the first instant after periodEnd's calendar day, UTC -- for the one source (pos_line_items, via square_orders.transaction_date) keyed by a timestamp rather than a plain date. */
function exclusiveEnd(periodEnd: string): string {
  const d = new Date(`${periodEnd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

/** account_type/statement_section lookup for `coaId`, shaped for coaSection(). Null if the account row can't be found (nothing to compute a section against). */
async function fetchCoaRecord(supabase: SupabaseClient, coaId: string): Promise<CoaRecord | null> {
  const { data, error } = await supabase
    .from("chart_of_accounts")
    .select("id, parent_id, account_name, account_number, account_type, statement_section")
    .eq("id", coaId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as {
    id: string;
    parent_id: string | null;
    account_name: string;
    account_number: string | null;
    account_type: string;
    statement_section: string | null;
  };
  return {
    id: row.id,
    parentId: row.parent_id,
    accountName: row.account_name,
    accountNumber: row.account_number,
    accountType: row.account_type,
    statementSection: row.statement_section,
  };
}

async function sumPos(supabase: SupabaseClient, coaId: string, periodEnd: string, section: string): Promise<{ sum: number; count: number }> {
  const rows = await fetchAllRows<{ net_sales_cents: number | null }>(() =>
    supabase
      .from("pos_line_items")
      .select("net_sales_cents, square_orders!inner ( transaction_date )")
      .eq("chart_of_accounts_id", coaId)
      .lt("square_orders.transaction_date", exclusiveEnd(periodEnd))
      .order("id", { ascending: true }),
  );
  const sum = rows.reduce((s, r) => s + normalizeSignedCents(r.net_sales_cents ?? 0, section, "pos"), 0);
  return { sum, count: rows.length };
}

async function sumInvoiceLines(supabase: SupabaseClient, coaId: string, periodEnd: string, section: string): Promise<{ sum: number; count: number }> {
  // invoice_line_items carries no date column of its own -- invoice_date
  // lives on the joined invoices row (mirrors fetchSources.ts's
  // fetchInvoiceLines / accruals.ts's taxAccrual invoice-tax join).
  //
  // The voided filter is NOT optional and NOT defensive. Every one of GL 2430's
  // five lines sits on a voided invoice, totalling 645,948 -- without this the
  // provider invents $6,459.48 of Contract Brewing Deposits liability that the
  // pre-PR-B pipeline never reported. Mirrors fetchSources.ts's own
  // `.neq("invoices.status", "voided")`.
  const rows = await fetchAllRows<{ total_cents: number | null }>(() =>
    supabase
      .from("invoice_line_items")
      .select("total_cents, invoices!invoice_line_items_invoice_id_fkey!inner ( invoice_date, status )")
      .eq("chart_of_accounts_id", coaId)
      .neq("invoices.status", "voided")
      .lte("invoices.invoice_date", periodEnd)
      .order("id", { ascending: true }),
  );
  const sum = rows.reduce((s, r) => s + normalizeSignedCents(r.total_cents ?? 0, section, "invoice"), 0);
  return { sum, count: rows.length };
}

async function sumExpenses(supabase: SupabaseClient, coaId: string, periodEnd: string, section: string): Promise<{ sum: number; count: number }> {
  // applyExpenseStatementFilters is what keeps DECLINED cards and
  // manually-excluded rows off the statements (fetchSources.ts:404 applies it
  // to the very same table). Omitting it here would let this provider count
  // money the P&L deliberately ignores. cashOnly=false: the balance sheet is
  // accrual-basis, matching fetchSources' non-cash-flow modes.
  const rows = await fetchAllRows<{ id: string; amount_cents: number | null }>(() =>
    applyExpenseStatementFilters(
      supabase
        .from("expenses")
        .select("id, amount_cents")
        .eq("chart_of_accounts_id", coaId)
        .lte("accounting_date", periodEnd)
        .order("id", { ascending: true }),
      false,
    ),
  );
  if (rows.length === 0) return { sum: 0, count: 0 };

  // PRECEDENCE: when an expense has split lines, the splits REPLACE its own
  // chart_of_accounts_id -- they do not add to it. aggregateRows.ts encodes this
  // as `row.splitLines?.length ? splitLines : [{ coaId: row.chartOfAccountsId }]`.
  //
  // Counting both double-counts real money. The parent's account is NOT cleared
  // when splits are created: app/api/finance/expenses/[id]/splits/route.ts
  // updates only `mapping_source`, and resolveExpenseMapping preserves the
  // existing chart_of_accounts_id on every later sync -- deliberately, so a
  // re-sync cannot re-code a parent whose real coding now lives in its splits.
  // So a $10,000 expense coded to 1310 and then split 1310/$3,000 + 6100/$7,000
  // would move 1310 by $13,000 without this exclusion.
  const splitParents = await fetchAllRows<{ expense_id: string }>(() =>
    supabase
      .from("expense_gl_splits")
      .select("expense_id")
      .in("expense_id", rows.map((r) => r.id))
      .order("id", { ascending: true }),
  );
  const hasSplits = new Set(splitParents.map((r) => r.expense_id));
  const own = rows.filter((r) => !hasSplits.has(r.id));

  const sum = own.reduce((s, r) => s + normalizeSignedCents(r.amount_cents ?? 0, section, "expense"), 0);
  return { sum, count: own.length };
}

/**
 * expense_gl_splits — an expense divided across several GL accounts.
 *
 * THIS IS NOT AN OPTIONAL EXTRA SOURCE. When an expense is split, the real GL
 * assignment lives on its split rows, and an account funded only by splits reads
 * $0 without this. (An earlier version of this comment claimed the parent's own
 * `chart_of_accounts_id` is NULL by design. It is not -- see the precedence note
 * in sumExpenses, which is why that function must exclude split parents.)
 *
 * Two accounts are in exactly that position, and both were reported as blank
 * before this function existed:
 *   * GL 1310 Security Deposits Paid — 2 splits, the account's ENTIRE balance.
 *   * GL 2310 Undistributed Tips — 17 splits carrying the payout side that
 *     settles the liability against tipAccrual's collections.
 *
 * `fetchSources.ts:408` expands splits for the same reason. The state/excluded
 * predicates are spelled out here rather than reusing applyExpenseStatementFilters
 * because they must target the EMBEDDED parent (`expenses.state`), which that
 * helper cannot express.
 */
async function sumExpenseSplits(supabase: SupabaseClient, coaId: string, periodEnd: string, section: string): Promise<{ sum: number; count: number }> {
  const rows = await fetchAllRows<{ amount_cents: number | null }>(() =>
    supabase
      .from("expense_gl_splits")
      .select("amount_cents, expenses!inner ( accounting_date, state, excluded_at )")
      .eq("chart_of_accounts_id", coaId)
      .lte("expenses.accounting_date", periodEnd)
      .or("state.is.null,state.neq.DECLINED", { referencedTable: "expenses" })
      .is("expenses.excluded_at", null)
      .order("id", { ascending: true }),
  );
  const sum = rows.reduce((s, r) => s + normalizeSignedCents(r.amount_cents ?? 0, section, "expense"), 0);
  return { sum, count: rows.length };
}

/**
 * square_refunds. The pre-PR-B pipeline fed these into the same aggregation as
 * everything else (fetchSources.ts:472), so omitting them here would drop the
 * entire refund side of any account they post to. Status and date filters
 * mirror that fetch exactly; `refunded_at` is a timestamp, hence exclusiveEnd.
 */
async function sumRefunds(supabase: SupabaseClient, coaId: string, periodEnd: string, section: string): Promise<{ sum: number; count: number }> {
  const rows = await fetchAllRows<{ amount_cents: number | null }>(() =>
    supabase
      .from("square_refunds")
      .select("amount_cents")
      .eq("chart_of_accounts_id", coaId)
      .eq("status", "COMPLETED")
      .lt("refunded_at", exclusiveEnd(periodEnd))
      .order("id", { ascending: true }),
  );
  const sum = rows.reduce((s, r) => s + normalizeSignedCents(r.amount_cents ?? 0, section, "refund"), 0);
  return { sum, count: rows.length };
}

/**
 * ramp_bank_ledger carries more than one source. `include_in_gl` is what says
 * whether a row is an accounting fact or merely an imported bank line.
 *
 * Ramp's rows default to true and are unaffected. Plaid's Chase rows are
 * imported false, because they exist only so a Square transfer can be recognised
 * from the receiving side (lib/finance/balances/bankTransactions.ts) and letting
 * them into this sum would change the reported balance of every account they
 * touch, across up to two years of imported history. Whether they ever should is
 * a deliberate decision with a switch waiting for it; this predicate is the
 * switch being off.
 */
async function sumBank(supabase: SupabaseClient, coaId: string, periodEnd: string, section: string): Promise<{ sum: number; count: number }> {
  const rows = await fetchAllRows<{ amount_cents: number | null }>(() =>
    supabase
      .from("ramp_bank_ledger")
      .select("amount_cents")
      .eq("chart_of_accounts_id", coaId)
      .eq("include_in_gl", true)
      .lte("transaction_date", periodEnd)
      .order("id", { ascending: true }),
  );
  const sum = rows.reduce((s, r) => s + normalizeSignedCents(r.amount_cents ?? 0, section, "bank"), 0);
  return { sum, count: rows.length };
}

export const transactionPostings: BalanceProvider = {
  key: "transactionPostings",
  label: "Transaction postings",
  kind: "derived",
  async compute(ctx: BalanceContext): Promise<number | null> {
    const { supabase, coaId, periodEnd } = ctx;

    const coa = await fetchCoaRecord(supabase, coaId);
    if (!coa) return null;
    const section = coaSection(coa);

    const [pos, invoiceLines, expenses, splits, bank, refunds] = await Promise.all([
      sumPos(supabase, coaId, periodEnd, section),
      sumInvoiceLines(supabase, coaId, periodEnd, section),
      sumExpenses(supabase, coaId, periodEnd, section),
      sumExpenseSplits(supabase, coaId, periodEnd, section),
      sumBank(supabase, coaId, periodEnd, section),
      sumRefunds(supabase, coaId, periodEnd, section),
    ]);

    const totalRows =
      pos.count + invoiceLines.count + expenses.count + splits.count + bank.count + refunds.count;
    if (totalRows === 0) return null;

    return pos.sum + invoiceLines.sum + expenses.sum + splits.sum + bank.sum + refunds.sum;
  },
};

registerProvider(transactionPostings);

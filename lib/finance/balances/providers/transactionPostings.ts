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
  const rows = await fetchAllRows<{ total_cents: number | null }>(() =>
    supabase
      .from("invoice_line_items")
      .select("total_cents, invoices!invoice_line_items_invoice_id_fkey!inner ( invoice_date )")
      .eq("chart_of_accounts_id", coaId)
      .lte("invoices.invoice_date", periodEnd)
      .order("id", { ascending: true }),
  );
  const sum = rows.reduce((s, r) => s + normalizeSignedCents(r.total_cents ?? 0, section, "invoice"), 0);
  return { sum, count: rows.length };
}

async function sumExpenses(supabase: SupabaseClient, coaId: string, periodEnd: string, section: string): Promise<{ sum: number; count: number }> {
  const rows = await fetchAllRows<{ amount_cents: number | null }>(() =>
    supabase
      .from("expenses")
      .select("amount_cents")
      .eq("chart_of_accounts_id", coaId)
      .lte("accounting_date", periodEnd)
      .order("id", { ascending: true }),
  );
  const sum = rows.reduce((s, r) => s + normalizeSignedCents(r.amount_cents ?? 0, section, "expense"), 0);
  return { sum, count: rows.length };
}

async function sumBank(supabase: SupabaseClient, coaId: string, periodEnd: string, section: string): Promise<{ sum: number; count: number }> {
  const rows = await fetchAllRows<{ amount_cents: number | null }>(() =>
    supabase
      .from("ramp_bank_ledger")
      .select("amount_cents")
      .eq("chart_of_accounts_id", coaId)
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

    const [pos, invoiceLines, expenses, bank] = await Promise.all([
      sumPos(supabase, coaId, periodEnd, section),
      sumInvoiceLines(supabase, coaId, periodEnd, section),
      sumExpenses(supabase, coaId, periodEnd, section),
      sumBank(supabase, coaId, periodEnd, section),
    ]);

    const totalRows = pos.count + invoiceLines.count + expenses.count + bank.count;
    if (totalRows === 0) return null;

    return pos.sum + invoiceLines.sum + expenses.sum + bank.sum;
  },
};

registerProvider(transactionPostings);

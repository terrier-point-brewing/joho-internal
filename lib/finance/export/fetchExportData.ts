// Gathers everything the bookkeeper workbook needs. The only module in this
// folder that touches the database.
//
// The three statements come from buildFinancials -- the same call the
// Financials screen makes -- so the workbook cannot disagree with the screen.
// The transaction detail comes from the same fetch layer the P&L reads
// (fetchFinancialsSources), resolved by postings.ts and then checked against
// the P&L by reconcileToStatement; any gap is carried into the workbook as a
// visible line rather than assumed away.
//
// Reads with the admin client throughout: invoices and their lines are
// readable by no user session (finance_reader_roles() is empty), and a
// request-scoped client returns zero rows without an error. Authorization is
// the route's job (CAP.financeStatementsRead).

import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows, PAGE_CONCURRENCY, PAGE_SIZE } from "@/lib/supabase/paginate";
import { buildFinancials } from "@/lib/finance/financials";
import { fetchFinancialsSources } from "@/lib/finance/financials/fetchSources";
import { applyExpenseStatementFilters } from "@/lib/finance/financials/expenseFilters";
import { billOwedAtFilter, invoiceOwedAtFilter } from "@/lib/finance/balances/owedAt";
import { derivedLines, reconcileToStatement, resolvePostings } from "./postings";
import { monthEndDate } from "./workbook";
import type { CoaDetail, ExportData, ManualEntryRow, OpenBill, OpenInvoice, PostingDetail } from "./workbook";

function join(parts: (string | null | undefined)[], separator = " - "): string {
  return parts.map((p) => (p ?? "").trim()).filter(Boolean).join(separator);
}

/** First day of the month after `month` ("YYYY-MM"), as "YYYY-MM-DD". */
function nextMonthStart(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}


async function fetchCoaDetail(supabase: SupabaseClient): Promise<CoaDetail[]> {
  const rows = await fetchAllRows<{
    id: string;
    parent_id: string | null;
    account_name: string;
    account_number: string | null;
    account_type: string;
    detail_type: string | null;
    description: string | null;
    is_active: boolean | null;
    statement_section: string | null;
    excluded: boolean | null;
  }>(() =>
    supabase
      .from("chart_of_accounts")
      .select("id, parent_id, account_name, account_number, account_type, detail_type, description, is_active, statement_section, excluded")
      .order("id", { ascending: true }),
  );
  return rows.map((r) => ({
    id: r.id,
    parentId: r.parent_id,
    accountName: r.account_name,
    accountNumber: r.account_number,
    accountType: r.account_type,
    statementSection: r.statement_section,
    excluded: r.excluded ?? false,
    detailType: r.detail_type,
    description: r.description,
    isActive: r.is_active ?? true,
  }));
}

/**
 * Descriptions for the postings, keyed by record id. Read by date window
 * rather than by id list: a year is thousands of ids, and an `.in()` that long
 * overflows the request URL.
 */
async function fetchPostingDetails(supabase: SupabaseClient, months: string[]): Promise<Map<string, PostingDetail>> {
  const startDate = `${months[0]}-01`;
  const endDate = monthEndDate(months[months.length - 1]);
  const start = `${startDate}T00:00:00Z`;
  const end = `${nextMonthStart(months[months.length - 1])}T00:00:00Z`;
  const out = new Map<string, PostingDetail>();

  const pos = await fetchAllRows<{
    id: string;
    name: string | null;
    variation_name: string | null;
    quantity: number | null;
    square_orders: { square_order_id: string | null; customer_name: string | null };
  }>(
    () =>
      supabase
        .from("pos_line_items")
        .select("id, name, variation_name, quantity, square_orders!inner ( transaction_date, square_order_id, customer_name )")
        .gte("square_orders.transaction_date", start)
        .lt("square_orders.transaction_date", end)
        .order("id", { ascending: true }),
    PAGE_SIZE,
    PAGE_CONCURRENCY,
  );
  for (const r of pos) {
    const item = join([r.name, r.variation_name]);
    out.set(r.id, {
      description: r.quantity !== null && r.quantity !== 1 ? `${item} x ${r.quantity}` : item,
      counterparty: r.square_orders.customer_name ?? "",
      reference: r.square_orders.square_order_id ?? "",
    });
  }

  const invoiceLines = await fetchAllRows<{
    id: string;
    line_item_name: string | null;
    description: string | null;
    variation_name: string | null;
    invoices: { invoice_number: string | null; customer_name: string | null };
  }>(() =>
    supabase
      .from("invoice_line_items")
      .select("id, line_item_name, description, variation_name, invoices!invoice_line_items_invoice_id_fkey!inner ( invoice_number, customer_name, invoice_date, status )")
      .neq("invoices.status", "voided")
      .gte("invoices.invoice_date", startDate)
      .lte("invoices.invoice_date", endDate)
      .order("id", { ascending: true }),
  );
  for (const r of invoiceLines) {
    out.set(r.id, {
      description: join([r.line_item_name ?? r.description, r.variation_name]),
      counterparty: r.invoices.customer_name ?? "",
      reference: r.invoices.invoice_number ? `Invoice ${r.invoices.invoice_number}` : "",
    });
  }

  const expenses = await fetchAllRows<{
    id: string;
    merchant_name: string | null;
    counterparty_label: string | null;
    memo: string | null;
    source: string | null;
    ramp_object: string | null;
    source_transaction_id: string | null;
  }>(() =>
    supabase
      .from("expenses")
      .select("id, merchant_name, counterparty_label, memo, source, ramp_object, source_transaction_id")
      .gte("accounting_date", startDate)
      .lte("accounting_date", endDate)
      .order("id", { ascending: true }),
  );
  for (const r of expenses) {
    out.set(r.id, {
      description: join([r.ramp_object ?? r.source, r.memo]),
      counterparty: r.merchant_name ?? r.counterparty_label ?? "",
      reference: r.source_transaction_id ?? "",
    });
  }

  const bank = await fetchAllRows<{
    id: string;
    description: string | null;
    counterparty_name: string | null;
    source: string | null;
    source_account_name: string | null;
    source_transaction_id: string | null;
  }>(() =>
    supabase
      .from("bank_ledger")
      .select("id, description, counterparty_name, source, source_account_name, source_transaction_id")
      .gte("transaction_date", startDate)
      .lte("transaction_date", endDate)
      .order("id", { ascending: true }),
  );
  for (const r of bank) {
    out.set(r.id, {
      description: join([r.source_account_name ?? r.source, r.description]),
      counterparty: r.counterparty_name ?? "",
      reference: r.source_transaction_id ?? "",
    });
  }

  // A refund posts either as itself or, when it was split by invoice line, as
  // its refund_lines -- so both ids must resolve to the same refund.
  const refunds = await fetchAllRows<{
    id: string;
    reason: string | null;
    square_refund_id: string | null;
    refund_lines: { id: string }[] | null;
  }>(() =>
    supabase
      .from("square_refunds")
      .select("id, reason, square_refund_id, refund_lines(id)")
      .gte("refunded_at", start)
      .lt("refunded_at", end)
      .order("id", { ascending: true }),
  );
  for (const r of refunds) {
    const detail: PostingDetail = { description: join(["Refund", r.reason]), counterparty: "", reference: r.square_refund_id ?? "" };
    out.set(r.id, detail);
    for (const line of r.refund_lines ?? []) out.set(line.id, detail);
  }

  return out;
}

/** Invoices owed at `periodEnd` -- the same rule GL 1100 uses (accruals.ts's openInvoiceAr). */
async function fetchOpenInvoices(supabase: SupabaseClient, periodEnd: string): Promise<OpenInvoice[]> {
  const rows = await fetchAllRows<{
    invoice_number: string | null;
    invoice_date: string;
    due_date: string | null;
    customer_name: string | null;
    status: string;
    total_cents: number | null;
  }>(() =>
    supabase
      .from("invoices")
      .select("invoice_number, invoice_date, due_date, customer_name, status, total_cents")
      .lte("invoice_date", periodEnd)
      .or(invoiceOwedAtFilter(periodEnd))
      .order("id", { ascending: true }),
  );
  return rows.map((r) => ({
    invoiceNumber: r.invoice_number,
    invoiceDate: r.invoice_date,
    dueDate: r.due_date,
    customerName: r.customer_name,
    // "paid" here means paid AFTER the period end: it was still owed on the day.
    status: r.status === "paid" ? "paid after period end" : r.status,
    totalCents: r.total_cents ?? 0,
  }));
}

/** Bills owed at `periodEnd` -- the same rule GL 2000 uses (accruals.ts's openBillAp). */
async function fetchOpenBills(supabase: SupabaseClient, periodEnd: string): Promise<OpenBill[]> {
  const rows = await fetchAllRows<{
    merchant_name: string | null;
    counterparty_label: string | null;
    accounting_date: string;
    memo: string | null;
    chart_of_accounts_id: string | null;
    amount_cents: number | null;
  }>(() =>
    applyExpenseStatementFilters(
      supabase
        .from("expenses")
        .select("merchant_name, counterparty_label, accounting_date, memo, chart_of_accounts_id, amount_cents")
        .eq("ramp_object", "bill")
        .lte("accounting_date", periodEnd)
        .or(billOwedAtFilter(periodEnd))
        .order("id", { ascending: true }),
      false,
    ),
  );
  return rows.map((r) => ({
    vendor: r.merchant_name ?? r.counterparty_label,
    billDate: r.accounting_date,
    memo: r.memo,
    accountId: r.chart_of_accounts_id,
    // Stored signed by cash direction (an outflow, so negative); shown as what is owed.
    amountCents: -(r.amount_cents ?? 0),
  }));
}

async function fetchManualEntries(supabase: SupabaseClient): Promise<ManualEntryRow[]> {
  const rows = await fetchAllRows<{
    entry_kind: string;
    label: string | null;
    chart_of_accounts_id: string | null;
    start_date: string | null;
    end_date: string | null;
    as_of_date: string | null;
    amount_cents: number | null;
    note: string | null;
  }>(() =>
    supabase
      .from("manual_entries")
      .select("entry_kind, label, chart_of_accounts_id, start_date, end_date, as_of_date, amount_cents, note")
      .order("id", { ascending: true }),
  );
  return rows.map((r) => ({
    kind: r.entry_kind,
    label: r.label,
    accountId: r.chart_of_accounts_id,
    startDate: r.start_date,
    endDate: r.end_date,
    asOfDate: r.as_of_date,
    amountCents: r.amount_cents ?? 0,
    note: r.note,
  }));
}

export async function fetchExportData(year: number): Promise<ExportData> {
  const supabase = createSupabaseAdminClient();

  // In two waves rather than all at once: each statement is itself a fan-out
  // of paged reads, and the API layer stalls under a burst.
  const [pl, sources, coa] = await Promise.all([
    buildFinancials({ statement: "pl", year }),
    fetchFinancialsSources({ statement: "pl", year }),
    fetchCoaDetail(supabase),
  ]);
  const [balanceSheet, cashFlow] = await Promise.all([
    buildFinancials({ statement: "balance_sheet", year }),
    buildFinancials({ statement: "cash_flow", year }),
  ]);

  const { months } = pl;
  const postings = resolvePostings(sources, months);
  const derived = derivedLines(pl.rows, months, sources.coa);
  const differences = reconcileToStatement(pl.rows, postings, derived, months);

  const bsMonths = balanceSheet.months;
  const periodEnd = monthEndDate(bsMonths[bsMonths.length - 1] ?? months[months.length - 1]);

  const details = await fetchPostingDetails(supabase, months);
  const [openInvoices, openBills, manualEntries] = await Promise.all([
    fetchOpenInvoices(supabase, periodEnd),
    fetchOpenBills(supabase, periodEnd),
    fetchManualEntries(supabase),
  ]);

  return {
    year,
    generatedAt: new Date().toISOString(),
    asOfDate: periodEnd,
    pl,
    balanceSheet,
    cashFlow,
    coa,
    postings,
    derived,
    differences,
    details,
    openInvoices,
    openBills,
    manualEntries,
  };
}

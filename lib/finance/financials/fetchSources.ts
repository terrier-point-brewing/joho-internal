// Raw Supabase fetch for the consolidated financials view. Reads ONLY
// persisted tables (no live Square), mirroring the data access + statement-
// mode semantics of app/api/finance/statements/route.ts (P&L MoM / cumulative
// BS / cash view) and app/api/finance/transactions/route.ts (POS
// account-mapping prefill), reshaped into the plain arrays aggregateRows
// (lib/finance/financials/aggregateRows.ts) consumes.
//
// Kept as its own function, isolated from aggregateRows/buildKpis/
// buildDataQuality, so buildFinancials.ts can mock this one function in
// tests instead of a live Supabase client — see buildFinancials.test.ts.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { buildInvoiceSalesReport } from "@/lib/finance/invoiceSalesReport";
import type { StatementKind } from "./types";
import type {
  PosLineRecord,
  InvoiceLineRecord,
  ExpenseRecord,
  BankLedgerRecord,
  RefundRecord,
  CoaRecord,
} from "./aggregateRows";

export interface FinancialsSourcesResult {
  pos: PosLineRecord[];
  invoiceLines: InvoiceLineRecord[];
  expenses: ExpenseRecord[];
  refunds: RefundRecord[];
  bank: BankLedgerRecord[];
  coa: CoaRecord[];
  /**
   * Month keys the fetched records are bounded to, ascending.
   *  - pl / cash_flow: the trailing (up to) 12 real calendar months, "YYYY-MM".
   *  - balance_sheet: a single synthetic key equal to the period-end month
   *    ("YYYY-12" or the current month for the current year). Every fetched
   *    record's date has already been normalized onto that one key so
   *    aggregateRows collapses the whole from-inception range into one
   *    bucket — preserving today's BS page's single-Total semantics
   *    (app/api/finance/statements/route.ts's cumulative=true mode).
   */
  months: string[];
  strandedDeposit: { count: number; cents: number };
  exciseCoverage: { shipmentsMissingExcise: number };
}

const VOLUME_CATEGORIES = new Set(["distribution_keg", "distribution_can"]);
const EXPORT_CHANNELS = new Set(["distribution", "contract_brewing", "wholesale"]);

// ── date range helpers ──────────────────────────────────────────────────────

interface DateRange {
  /** Inclusive lower bound, "YYYY-MM-DD" (invoices/expenses/bank) or ISO timestamp (pos/refunds). Null = from inception. */
  startDateStr: string | null;
  start: string | null;
  /** Inclusive upper bound, "YYYY-MM-DD". */
  endDateStr: string;
  /** Exclusive upper bound, ISO timestamp (first instant of the month after endDateStr's month). */
  end: string;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Last real calendar month to include: the current month if `year` is the current year, else December. */
function periodEndYearMonth(year: number, now: Date): { y: number; m: number } {
  return year === now.getFullYear() ? { y: year, m: now.getMonth() + 1 } : { y: year, m: 12 };
}

/** Trailing (up to) 12 real calendar months ending at `year`'s period end, ascending "YYYY-MM". Explicitly capped at 12. */
export function trailingMonths(year: number, now: Date = new Date()): string[] {
  const { y: endY, m: endM } = periodEndYearMonth(year, now);
  const months: string[] = [];
  let y = endY, m = endM;
  for (let i = 0; i < 12; i++) {
    months.unshift(`${y}-${pad(m)}`);
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  return months.slice(-12);
}

function rangeFromMonths(months: string[]): DateRange {
  const [firstY, firstM] = months[0].split("-").map(Number);
  const [lastY, lastM] = months[months.length - 1].split("-").map(Number);
  const nextY = lastM === 12 ? lastY + 1 : lastY;
  const nextM = lastM === 12 ? 1 : lastM + 1;
  return {
    startDateStr: `${firstY}-${pad(firstM)}-01`,
    start: `${firstY}-${pad(firstM)}-01T00:00:00Z`,
    endDateStr: `${lastY}-${pad(lastM)}-${pad(new Date(lastY, lastM, 0).getDate())}`,
    end: `${nextY}-${pad(nextM)}-01T00:00:00Z`,
  };
}

/** Cumulative-from-inception range through the end of `year`'s period-end month. */
function cumulativeRange(year: number, now: Date): { range: DateRange; canonicalMonth: string } {
  const { y, m } = periodEndYearMonth(year, now);
  const canonicalMonth = `${y}-${pad(m)}`;
  return {
    range: {
      startDateStr: null,
      start: null,
      endDateStr: `${y}-${pad(m)}-${pad(new Date(y, m, 0).getDate())}`,
      end: `${m === 12 ? y + 1 : y}-${pad(m === 12 ? 1 : m + 1)}-01T00:00:00Z`,
    },
    canonicalMonth,
  };
}

/** Collapses every record's date field onto `canonical`, for balance_sheet's single-Total bucket. */
function collapseDates<T, K extends keyof T>(records: T[], field: K, canonical: T[K]): T[] {
  return records.map((r) => ({ ...r, [field]: canonical }));
}

// ── per-source fetches ──────────────────────────────────────────────────────

async function fetchCoa(supabase: SupabaseClient): Promise<CoaRecord[]> {
  const { data } = await supabase
    .from("chart_of_accounts")
    .select("id, parent_id, account_name, account_type, statement_section");
  return (data ?? []).map((r) => ({
    id: r.id,
    parentId: r.parent_id,
    accountName: r.account_name,
    accountType: r.account_type,
    statementSection: r.statement_section ?? null,
  }));
}

async function fetchPos(supabase: SupabaseClient, range: DateRange): Promise<PosLineRecord[]> {
  let q = supabase
    .from("pos_line_items")
    .select(`
      id, net_sales_cents, quantity, variation_name, chart_of_accounts_id, square_variation_id,
      square_orders!inner ( transaction_date, invoice_id )
    `)
    .lt("square_orders.transaction_date", range.end);
  if (range.start) q = q.gte("square_orders.transaction_date", range.start);

  const { data } = await q;
  const rows = (data ?? []) as unknown as {
    id: string;
    net_sales_cents: number | null;
    quantity: number | null;
    variation_name: string | null;
    chart_of_accounts_id: string | null;
    square_variation_id: string | null;
    square_orders: { transaction_date: string; invoice_id: string | null };
  }[];

  // Account-mapping prefill + category id, joined via square_catalog_variations
  // -> square_catalog_items (mirrors app/api/finance/transactions/route.ts).
  const variationIds = [...new Set(rows.map((r) => r.square_variation_id).filter((v): v is string => !!v))];
  const catalogLookup: Record<string, { chartOfAccountsId: string | null; categoryId: string | null; itemName: string | null }> = {};
  if (variationIds.length > 0) {
    const { data: variations } = await supabase
      .from("square_catalog_variations")
      .select("square_variation_id, chart_of_accounts_id, square_catalog_items ( category_id, item_name )")
      .in("square_variation_id", variationIds);
    for (const v of (variations ?? []) as unknown as {
      square_variation_id: string;
      chart_of_accounts_id: string | null;
      square_catalog_items: { category_id: string | null; item_name: string | null } | { category_id: string | null; item_name: string | null }[] | null;
    }[]) {
      const item = Array.isArray(v.square_catalog_items) ? v.square_catalog_items[0] : v.square_catalog_items;
      catalogLookup[v.square_variation_id] = {
        chartOfAccountsId: v.chart_of_accounts_id,
        categoryId: item?.category_id ?? null,
        itemName: item?.item_name ?? null,
      };
    }
  }

  // Post-migration (20260625) pos_line_items excludes invoice-backed rows, so
  // invoiceId is normally null; kept for forward-compat with any future
  // invoice-backed POS rows, resolved the same way invoice lines resolve theirs.
  const invoiceIds = [...new Set(rows.map((r) => r.square_orders.invoice_id).filter((v): v is string => !!v))];
  const exportChannelByInvoice: Record<string, string | null> = {};
  if (invoiceIds.length > 0) {
    const { data: exportRows } = await supabase
      .from("export_transactions")
      .select("invoice_id, channel")
      .in("invoice_id", invoiceIds);
    for (const e of (exportRows ?? []) as { invoice_id: string | null; channel: string }[]) {
      if (e.invoice_id) exportChannelByInvoice[e.invoice_id] = e.channel;
    }
  }

  return rows.map((r) => {
    const catalog = r.square_variation_id ? catalogLookup[r.square_variation_id] : undefined;
    const itemName = catalog?.itemName ?? r.variation_name ?? "";
    const invoiceId = r.square_orders.invoice_id;
    return {
      id: r.id,
      netSalesCents: r.net_sales_cents ?? 0,
      transactionDate: r.square_orders.transaction_date,
      chartOfAccountsId: r.chart_of_accounts_id,
      prefillChartOfAccountsId: catalog?.chartOfAccountsId ?? null,
      invoiceId,
      isEventPour: itemName.toLowerCase().includes("event pour"),
      exportChannel: invoiceId ? exportChannelByInvoice[invoiceId] ?? null : null,
      categoryId: catalog?.categoryId ?? null,
      variationName: r.variation_name,
      quantity: r.quantity ?? 0,
    };
  });
}

async function fetchInvoiceLines(supabase: SupabaseClient, range: DateRange, cashOnly: boolean): Promise<InvoiceLineRecord[]> {
  let q = supabase
    .from("invoice_line_items")
    .select(`
      id, total_cents, category, chart_of_accounts_id, bs_chart_of_accounts_id, pl_chart_of_accounts_id,
      delivery_invoice_id, account_mode,
      invoices!invoice_line_items_invoice_id_fkey!inner ( id, invoice_date, status ),
      export_transactions ( channel, volume_bbl )
    `)
    .neq("invoices.status", "voided")
    .lte("invoices.invoice_date", range.endDateStr);
  if (range.startDateStr) q = q.gte("invoices.invoice_date", range.startDateStr);
  if (cashOnly) q = q.eq("invoices.status", "paid");

  const { data } = await q;
  const rows = (data ?? []) as unknown as {
    id: string;
    total_cents: number | null;
    category: string | null;
    chart_of_accounts_id: string | null;
    bs_chart_of_accounts_id: string | null;
    pl_chart_of_accounts_id: string | null;
    delivery_invoice_id: string | null;
    account_mode: "force_bs" | "force_pl" | null;
    invoices: { id: string; invoice_date: string; status: string };
    export_transactions: { channel: string; volume_bbl: number | null }[] | null;
  }[];

  // Deposit recognition: which linked delivery invoices are paid (mirrors
  // app/api/finance/statements/route.ts's resolveCoaId).
  const deliveryIds = [...new Set(rows.map((r) => r.delivery_invoice_id).filter((v): v is string => !!v))];
  const paidDeliveryIds = new Set<string>();
  if (deliveryIds.length > 0) {
    const { data: deliveries } = await supabase.from("invoices").select("id, status").in("id", deliveryIds).eq("status", "paid");
    for (const d of deliveries ?? []) paidDeliveryIds.add(d.id);
  }

  return rows.map((r) => {
    const exports = r.export_transactions ?? [];
    // export_transactions links at the invoice level, not per line item, so a
    // line's channel/volume is attributed from its invoice's export txns.
    // Known limitation: when an invoice has multiple export_transactions of
    // different channels ("ambiguous"), or spans multiple volume-bearing
    // lines, this can't split volume precisely per line -- it sums the
    // invoice's total volume onto each volume-bearing line's category. Flag
    // for validation once real data is available (see task report).
    const channelSet = new Set(exports.map((e) => e.channel).filter((c) => EXPORT_CHANNELS.has(c)));
    const exportChannel = channelSet.size === 1 ? [...channelSet][0] : null;
    const totalVolumeBbl = exports.reduce((s, e) => s + (e.volume_bbl ?? 0), 0);
    const volumeBbl = r.category && VOLUME_CATEGORIES.has(r.category) ? totalVolumeBbl : null;

    return {
      id: r.id,
      totalCents: r.total_cents ?? 0,
      invoiceDate: r.invoices.invoice_date,
      chartOfAccountsId: r.chart_of_accounts_id,
      bsChartOfAccountsId: r.bs_chart_of_accounts_id,
      plChartOfAccountsId: r.pl_chart_of_accounts_id,
      deliveryInvoiceId: r.delivery_invoice_id,
      accountMode: r.account_mode,
      deliveryInvoicePaid: !!(r.delivery_invoice_id && paidDeliveryIds.has(r.delivery_invoice_id)),
      exportChannel,
      volumeBbl,
    };
  });
}

async function fetchExpenses(supabase: SupabaseClient, range: DateRange, cashOnly: boolean): Promise<ExpenseRecord[]> {
  let q = supabase
    .from("expenses")
    .select("id, chart_of_accounts_id, amount_cents, accounting_date, mapping_source, state")
    .lte("accounting_date", range.endDateStr);
  if (range.startDateStr) q = q.gte("accounting_date", range.startDateStr);
  q = cashOnly ? q.eq("state", "CLEARED") : q.or("state.is.null,state.neq.DECLINED");

  const { data } = await q;
  return (data ?? []).map((r) => ({
    id: r.id,
    chartOfAccountsId: r.chart_of_accounts_id,
    amountCents: r.amount_cents ?? 0,
    accountingDate: r.accounting_date,
    mappingSource: (r.mapping_source ?? "unmapped") as ExpenseRecord["mappingSource"],
  }));
}

async function fetchBank(supabase: SupabaseClient, range: DateRange): Promise<BankLedgerRecord[]> {
  // ramp_bank_ledger rows are settled bank-account movement by definition --
  // there is no separate "cleared" concept to filter on for cash_flow mode.
  let q = supabase
    .from("ramp_bank_ledger")
    .select("id, chart_of_accounts_id, amount_cents, transaction_date, mapping_source")
    .not("chart_of_accounts_id", "is", null)
    .lte("transaction_date", range.endDateStr);
  if (range.startDateStr) q = q.gte("transaction_date", range.startDateStr);

  const { data } = await q;
  return (data ?? []).map((r) => ({
    id: r.id,
    chartOfAccountsId: r.chart_of_accounts_id,
    amountCents: r.amount_cents ?? 0,
    transactionDate: r.transaction_date,
    mappingSource: (r.mapping_source ?? "unmapped") as BankLedgerRecord["mappingSource"],
  }));
}

async function fetchRefunds(supabase: SupabaseClient, range: DateRange): Promise<RefundRecord[]> {
  let q = supabase
    .from("square_refunds")
    .select("id, chart_of_accounts_id, amount_cents, refunded_at")
    .eq("status", "COMPLETED")
    .lt("refunded_at", range.end);
  if (range.start) q = q.gte("refunded_at", range.start);

  const { data } = await q;
  return (data ?? []).map((r) => ({
    id: r.id,
    chartOfAccountsId: r.chart_of_accounts_id,
    amountCents: r.amount_cents ?? 0,
    refundedAt: r.refunded_at,
  }));
}

/** Invoice deposit lines stranded with no linked delivery invoice (app/finance/transactions/invoices/page.tsx's "deposit missing delivery" flag). Not year-bounded -- a data-quality indicator of current state, not a period figure. */
async function fetchStrandedDeposit(supabase: SupabaseClient): Promise<{ count: number; cents: number }> {
  const { data } = await supabase
    .from("invoice_line_items")
    .select("total_cents")
    .not("bs_chart_of_accounts_id", "is", null)
    .is("delivery_invoice_id", null);
  const rows = data ?? [];
  return { count: rows.length, cents: rows.reduce((s, r) => s + Math.abs(r.total_cents ?? 0), 0) };
}

/** Reuses lib/finance/invoiceSalesReport.ts's exciseCoverage rather than reinventing the TPB-liable-shipments-missing-excise computation. */
async function fetchExciseCoverage(supabase: SupabaseClient, year: number): Promise<{ shipmentsMissingExcise: number }> {
  const report = await buildInvoiceSalesReport(supabase, year);
  return { shipmentsMissingExcise: report.exciseCoverage.missingDetailTxns };
}

// ── entry point ──────────────────────────────────────────────────────────

export async function fetchFinancialsSources(params: { statement: StatementKind; year: number }): Promise<FinancialsSourcesResult> {
  const { statement, year } = params;
  const now = new Date();
  const supabase = createSupabaseAdminClient();
  const cashOnly = statement === "cash_flow";

  let range: DateRange;
  let months: string[];
  let canonicalMonth: string | null = null;

  if (statement === "balance_sheet") {
    const cum = cumulativeRange(year, now);
    range = cum.range;
    canonicalMonth = cum.canonicalMonth;
    months = [canonicalMonth];
  } else {
    months = trailingMonths(year, now);
    range = rangeFromMonths(months);
  }

  const [coa, pos, invoiceLines, expenses, bank, refunds, strandedDeposit, exciseCoverage] = await Promise.all([
    fetchCoa(supabase),
    fetchPos(supabase, range),
    fetchInvoiceLines(supabase, range, cashOnly),
    fetchExpenses(supabase, range, cashOnly),
    fetchBank(supabase, range),
    fetchRefunds(supabase, range),
    fetchStrandedDeposit(supabase),
    fetchExciseCoverage(supabase, year),
  ]);

  if (canonicalMonth) {
    return {
      coa,
      pos: collapseDates(pos, "transactionDate", canonicalMonth),
      invoiceLines: collapseDates(invoiceLines, "invoiceDate", canonicalMonth),
      expenses: collapseDates(expenses, "accountingDate", canonicalMonth),
      bank: collapseDates(bank, "transactionDate", canonicalMonth),
      refunds: collapseDates(refunds, "refundedAt", canonicalMonth),
      months,
      strandedDeposit,
      exciseCoverage,
    };
  }

  return { coa, pos, invoiceLines, expenses, bank, refunds, months, strandedDeposit, exciseCoverage };
}

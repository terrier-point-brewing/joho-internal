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
  /**
   * balance_sheet mode only: the first "Accounts receivable (A/R)" account
   * in the chart of accounts (mirrors app/api/finance/statements/route.ts's
   * arAccount, which is also a bare `.find()` -- first row in whatever order
   * Supabase returns, no explicit ORDER BY). Null for pl/cash_flow, and null
   * if no A/R account is configured.
   */
  arAccount: { id: string; name: string } | null;
  /**
   * balance_sheet mode only: sum of invoices.total_cents where status='open'
   * and invoice_date <= the BS period end (mirrors
   * app/api/finance/statements/route.ts:474-488's arCents). 0 for
   * pl/cash_flow.
   */
  openInvoiceArCents: number;
}

const VOLUME_CATEGORIES = new Set(["distribution_keg", "distribution_can"]);
const EXPORT_CHANNELS = new Set(["distribution", "contract_brewing", "wholesale"]);

// ── pagination helper ───────────────────────────────────────────────────────

const PAGE_SIZE = 1000;

/**
 * Pages through a Supabase select in chunks of PAGE_SIZE (PostgREST's default
 * row cap -- an unpaginated select silently truncates at 1000 rows with no
 * error). Loops `.range()` until a page returns fewer rows than PAGE_SIZE.
 *
 * `build` must return a FRESH query builder (filters + a stable `.order()`
 * already applied, no `.range()` yet) on every call -- Supabase builders are
 * single-use, so the same instance can't be re-ranged across pages. A stable
 * order is required for `.range()` to page correctly (unordered pages can
 * overlap or skip rows); call sites are responsible for adding it.
 *
 * `pageSize` defaults to PAGE_SIZE; overridable for tests only (a fake pager
 * driven by a smaller page size exercises the same multi-page loop without
 * needing 1000+ fixture rows).
 */
export async function fetchAllRows<T>(
  build: () => { range: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }> },
  pageSize: number = PAGE_SIZE,
): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return out;
}

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
  const data = await fetchAllRows<{
    id: string;
    parent_id: string | null;
    account_name: string;
    account_type: string;
    statement_section: string | null;
  }>(() =>
    supabase
      .from("chart_of_accounts")
      .select("id, parent_id, account_name, account_type, statement_section")
      .order("id", { ascending: true }),
  );
  return data.map((r) => ({
    id: r.id,
    parentId: r.parent_id,
    accountName: r.account_name,
    accountType: r.account_type,
    statementSection: r.statement_section ?? null,
  }));
}

async function fetchPos(supabase: SupabaseClient, range: DateRange): Promise<PosLineRecord[]> {
  const rows = await fetchAllRows<{
    id: string;
    net_sales_cents: number | null;
    quantity: number | null;
    variation_name: string | null;
    chart_of_accounts_id: string | null;
    square_variation_id: string | null;
    square_orders: { transaction_date: string; invoice_id: string | null };
  }>(() => {
    let q = supabase
      .from("pos_line_items")
      .select(`
        id, net_sales_cents, quantity, variation_name, chart_of_accounts_id, square_variation_id,
        square_orders!inner ( transaction_date, invoice_id )
      `)
      .lt("square_orders.transaction_date", range.end)
      .order("id", { ascending: true });
    if (range.start) q = q.gte("square_orders.transaction_date", range.start);
    return q;
  });

  // Account-mapping prefill + category id, joined via square_catalog_variations
  // -> square_catalog_items (mirrors app/api/finance/transactions/route.ts).
  const variationIds = [...new Set(rows.map((r) => r.square_variation_id).filter((v): v is string => !!v))];
  const catalogLookup: Record<string, { chartOfAccountsId: string | null; categoryId: string | null; itemName: string | null }> = {};
  if (variationIds.length > 0) {
    const variations = await fetchAllRows<{
      square_variation_id: string;
      chart_of_accounts_id: string | null;
      square_catalog_items: { category_id: string | null; item_name: string | null } | { category_id: string | null; item_name: string | null }[] | null;
    }>(() =>
      supabase
        .from("square_catalog_variations")
        .select("square_variation_id, chart_of_accounts_id, square_catalog_items ( category_id, item_name )")
        .in("square_variation_id", variationIds)
        .order("square_variation_id", { ascending: true }),
    );
    for (const v of variations) {
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
    const exportRows = await fetchAllRows<{ invoice_id: string | null; channel: string }>(() =>
      supabase
        .from("export_transactions")
        .select("invoice_id, channel")
        .in("invoice_id", invoiceIds)
        .order("id", { ascending: true }),
    );
    for (const e of exportRows) {
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
  const rows = await fetchAllRows<{
    id: string;
    total_cents: number | null;
    category: string | null;
    chart_of_accounts_id: string | null;
    bs_chart_of_accounts_id: string | null;
    pl_chart_of_accounts_id: string | null;
    delivery_invoice_id: string | null;
    account_mode: "force_bs" | "force_pl" | null;
    invoices: {
      id: string;
      invoice_date: string;
      status: string;
      export_transactions: { channel: string; volume_bbl: number | null }[] | null;
    };
  }>(() => {
    let q = supabase
      .from("invoice_line_items")
      .select(`
        id, total_cents, category, chart_of_accounts_id, bs_chart_of_accounts_id, pl_chart_of_accounts_id,
        delivery_invoice_id, account_mode,
        invoices!invoice_line_items_invoice_id_fkey!inner ( id, invoice_date, status, export_transactions ( channel, volume_bbl ) )
      `)
      .neq("invoices.status", "voided")
      .lte("invoices.invoice_date", range.endDateStr)
      .order("id", { ascending: true });
    if (range.startDateStr) q = q.gte("invoices.invoice_date", range.startDateStr);
    if (cashOnly) q = q.eq("invoices.status", "paid");
    return q;
  });

  // Deposit recognition: which linked delivery invoices are paid (mirrors
  // app/api/finance/statements/route.ts's resolveCoaId).
  const deliveryIds = [...new Set(rows.map((r) => r.delivery_invoice_id).filter((v): v is string => !!v))];
  const paidDeliveryIds = new Set<string>();
  if (deliveryIds.length > 0) {
    const deliveries = await fetchAllRows<{ id: string; status: string }>(() =>
      supabase.from("invoices").select("id, status").in("id", deliveryIds).eq("status", "paid").order("id", { ascending: true }),
    );
    for (const d of deliveries) paidDeliveryIds.add(d.id);
  }

  // export_transactions links at the invoice level, not per line item, so an
  // invoice's total volume must be attributed exactly ONCE across that
  // invoice's lines -- otherwise a multi-volume-line invoice (e.g. a keg line
  // + a can line) has its BBL replicated onto every volume-bearing line,
  // overstating bblByMonth once aggregateRows sums across lines. Volume is
  // per-shipment, not per-GL-line, so there's no correct way to split it at
  // the fine account grain; instead we concentrate the invoice's full volume
  // onto a single representative volume-bearing line (the first one
  // encountered) and record 0 on the rest. Channel/month BBL totals are
  // still correct since channel is invoice-level and all of an invoice's
  // volume shares one channel -- only the per-account-row grain is coarser.
  const volumeAssignedInvoiceIds = new Set<string>();

  return rows.map((r) => {
    const exports = r.invoices.export_transactions ?? [];
    // Known limitation: when an invoice has multiple export_transactions of
    // different channels ("ambiguous"), this can't resolve a single channel
    // per line. Flag for validation once real data is available (see task
    // report).
    const channelSet = new Set(exports.map((e) => e.channel).filter((c) => EXPORT_CHANNELS.has(c)));
    const exportChannel = channelSet.size === 1 ? [...channelSet][0] : null;
    const totalVolumeBbl = exports.reduce((s, e) => s + (e.volume_bbl ?? 0), 0);

    let volumeBbl: number | null = null;
    if (r.category && VOLUME_CATEGORIES.has(r.category)) {
      if (volumeAssignedInvoiceIds.has(r.invoices.id)) {
        volumeBbl = 0;
      } else {
        volumeBbl = totalVolumeBbl;
        volumeAssignedInvoiceIds.add(r.invoices.id);
      }
    }

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
  const data = await fetchAllRows<{
    id: string;
    chart_of_accounts_id: string | null;
    amount_cents: number | null;
    accounting_date: string;
    mapping_source: string | null;
    state: string | null;
  }>(() => {
    let q = supabase
      .from("expenses")
      .select("id, chart_of_accounts_id, amount_cents, accounting_date, mapping_source, state")
      .lte("accounting_date", range.endDateStr)
      .order("id", { ascending: true });
    if (range.startDateStr) q = q.gte("accounting_date", range.startDateStr);
    q = cashOnly ? q.eq("state", "CLEARED") : q.or("state.is.null,state.neq.DECLINED");
    return q;
  });
  return data.map((r) => ({
    id: r.id,
    chartOfAccountsId: r.chart_of_accounts_id,
    amountCents: r.amount_cents ?? 0,
    accountingDate: r.accounting_date,
    mappingSource: (r.mapping_source ?? "unmapped") as ExpenseRecord["mappingSource"],
  }));
}

async function fetchBank(supabase: SupabaseClient, range: DateRange, statement: StatementKind): Promise<BankLedgerRecord[]> {
  const data = await fetchAllRows<{
    id: string;
    chart_of_accounts_id: string | null;
    amount_cents: number | null;
    transaction_date: string;
    mapping_source: string | null;
  }>(() => {
    // ramp_bank_ledger rows are settled bank-account movement by definition --
    // there is no separate "cleared" concept to filter on for cash_flow mode.
    let q = supabase
      .from("ramp_bank_ledger")
      .select("id, chart_of_accounts_id, amount_cents, transaction_date, mapping_source")
      .lte("transaction_date", range.endDateStr)
      .order("id", { ascending: true });
    if (range.startDateStr) q = q.gte("transaction_date", range.startDateStr);

    // ramp_bank_ledger mixes true P&L movement (interest_income) with rows that
    // never belong on the P&L/cash-flow statement -- internal_transfer,
    // bill_settlement, card_settlement, deposit, unclassified (20260725
    // migration's affects_pl flag). Including those in pl/cash_flow
    // double-counts the expense they settle and pollutes income with
    // transfers (C2, Task 15 final review). balance_sheet's cumulative cash
    // balance legitimately needs every row that moved the bank balance,
    // transfers/settlements included -- deliberately left unfiltered here;
    // that BS bank treatment is a separate open item, not addressed by this fix.
    if (statement === "pl" || statement === "cash_flow") {
      q = q.eq("affects_pl", true);
    }
    return q;
  });
  return data.map((r) => ({
    id: r.id,
    chartOfAccountsId: r.chart_of_accounts_id,
    amountCents: r.amount_cents ?? 0,
    transactionDate: r.transaction_date,
    mappingSource: (r.mapping_source ?? "unmapped") as BankLedgerRecord["mappingSource"],
  }));
}

async function fetchRefunds(supabase: SupabaseClient, range: DateRange): Promise<RefundRecord[]> {
  const data = await fetchAllRows<{
    id: string;
    chart_of_accounts_id: string | null;
    amount_cents: number | null;
    refunded_at: string;
  }>(() => {
    let q = supabase
      .from("square_refunds")
      .select("id, chart_of_accounts_id, amount_cents, refunded_at")
      .eq("status", "COMPLETED")
      .lt("refunded_at", range.end)
      .order("id", { ascending: true });
    if (range.start) q = q.gte("refunded_at", range.start);
    return q;
  });
  return data.map((r) => ({
    id: r.id,
    chartOfAccountsId: r.chart_of_accounts_id,
    amountCents: r.amount_cents ?? 0,
    refundedAt: r.refunded_at,
  }));
}

/** Invoice deposit lines stranded with no linked delivery invoice (app/finance/transactions/invoices/page.tsx's "deposit missing delivery" flag). Not year-bounded -- a data-quality indicator of current state, not a period figure. */
async function fetchStrandedDeposit(supabase: SupabaseClient): Promise<{ count: number; cents: number }> {
  const rows = await fetchAllRows<{ total_cents: number | null }>(() =>
    supabase
      .from("invoice_line_items")
      .select("total_cents")
      .not("bs_chart_of_accounts_id", "is", null)
      .is("delivery_invoice_id", null)
      .order("id", { ascending: true }),
  );
  return { count: rows.length, cents: rows.reduce((s, r) => s + Math.abs(r.total_cents ?? 0), 0) };
}

/** Reuses lib/finance/invoiceSalesReport.ts's exciseCoverage rather than reinventing the TPB-liable-shipments-missing-excise computation. */
async function fetchExciseCoverage(supabase: SupabaseClient, year: number): Promise<{ shipmentsMissingExcise: number }> {
  const report = await buildInvoiceSalesReport(supabase, year);
  return { shipmentsMissingExcise: report.exciseCoverage.missingDetailTxns };
}

/**
 * Open-invoice A/R total as of the BS period end -- mirrors
 * app/api/finance/statements/route.ts:474-488's open-invoice sum exactly
 * (status='open', invoice_date <= period end). Deliberately NOT bounded by
 * the range's lower bound: like the old route, this is a point-in-time
 * open-balance snapshot, not a period movement.
 */
async function fetchOpenInvoiceAr(supabase: SupabaseClient, endDateStr: string): Promise<number> {
  const rows = await fetchAllRows<{ total_cents: number | null }>(() =>
    supabase
      .from("invoices")
      .select("total_cents")
      .eq("status", "open")
      .lte("invoice_date", endDateStr)
      .order("id", { ascending: true }),
  );
  return rows.reduce((s, inv) => s + (inv.total_cents ?? 0), 0);
}

// ── entry point ──────────────────────────────────────────────────────────

export async function fetchFinancialsSources(params: { statement: StatementKind; year: number }): Promise<FinancialsSourcesResult> {
  const { statement, year } = params;
  const now = new Date();
  const supabase = createSupabaseAdminClient();
  const cashOnly = statement === "cash_flow";
  const isBalanceSheet = statement === "balance_sheet";

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

  const [coa, pos, invoiceLines, expenses, bank, refunds, strandedDeposit, exciseCoverage, openInvoiceArCents] = await Promise.all([
    fetchCoa(supabase),
    fetchPos(supabase, range),
    fetchInvoiceLines(supabase, range, cashOnly),
    fetchExpenses(supabase, range, cashOnly),
    fetchBank(supabase, range, statement),
    fetchRefunds(supabase, range),
    fetchStrandedDeposit(supabase),
    fetchExciseCoverage(supabase, year),
    isBalanceSheet ? fetchOpenInvoiceAr(supabase, range.endDateStr) : Promise.resolve(0),
  ]);

  const arAcct = isBalanceSheet ? coa.find((c) => c.accountType === "Accounts receivable (A/R)") : undefined;
  const arAccount = arAcct ? { id: arAcct.id, name: arAcct.accountName } : null;

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
      arAccount,
      openInvoiceArCents,
    };
  }

  return { coa, pos, invoiceLines, expenses, bank, refunds, months, strandedDeposit, exciseCoverage, arAccount, openInvoiceArCents };
}

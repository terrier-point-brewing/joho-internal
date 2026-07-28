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
import { fetchAllRows } from "@/lib/supabase/paginate";
import { buildInvoiceSalesReport } from "@/lib/finance/invoiceSalesReport";
import { applyExpenseStatementFilters } from "./expenseFilters";
import type { StatementKind } from "./types";
import type {
  PosLineRecord,
  InvoiceLineRecord,
  ExpenseRecord,
  BankLedgerRecord,
  RefundRecord,
  CoaRecord,
  TipAccrualRecord,
} from "./aggregateRows";
import type { ManualNetSalesEntryRecord } from "./manualNetSales";

export interface FinancialsSourcesResult {
  pos: PosLineRecord[];
  invoiceLines: InvoiceLineRecord[];
  expenses: ExpenseRecord[];
  refunds: RefundRecord[];
  bank: BankLedgerRecord[];
  /**
   * balance_sheet mode only: a single derived accrual record (keyed to the
   * canonical month) summing collected card tips (square_orders.tip_cents,
   * taproom-basis) across the whole cumulative range -- credits the tips
   * liability the same way a tip payout debits it (see aggregateRows.ts's
   * resolveTipAccrual). Always [] for pl/cash_flow (no P&L analog) and when
   * payroll_gl_settings.tips_chart_of_accounts_id is unset or the column
   * doesn't exist yet (migration 20260823 pending) -- see fetchTipAccruals.
   */
  tipAccruals: TipAccrualRecord[];
  coa: CoaRecord[];
  /**
   * manual_net_sales_entries rows, unbounded by date range (proration happens
   * per-month in buildFinancials.ts's injectManualNetSales, mirroring the
   * deleted app/api/finance/sales/taproom/route.ts). pl/cash_flow modes only
   * -- always [] for balance_sheet (Square parity fix B: this is a P&L
   * revenue adjustment, it has no balance-sheet analog).
   */
  manualNetSalesEntries: ManualNetSalesEntryRecord[];
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

// `fetchAllRows` now lives in the shared `lib/supabase/paginate` module so any
// feature (not just financials) can page past PostgREST's silent row cap. It's
// imported above for the per-source fetches here; re-exported for the existing
// `./fetchSources` import sites + parity tests.
export { fetchAllRows };

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
    account_number: string | null;
    account_type: string;
    statement_section: string | null;
  }>(() =>
    supabase
      .from("chart_of_accounts")
      .select("id, parent_id, account_name, account_number, account_type, statement_section")
      .order("id", { ascending: true }),
  );
  return data.map((r) => ({
    id: r.id,
    parentId: r.parent_id,
    accountName: r.account_name,
    accountNumber: r.account_number,
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

export async function fetchInvoiceLines(supabase: SupabaseClient, range: DateRange, cashOnly: boolean): Promise<InvoiceLineRecord[]> {
  const rows = await fetchAllRows<{
    id: string;
    total_cents: number | null;
    category: string | null;
    chart_of_accounts_id: string | null;
    invoices: {
      id: string;
      invoice_date: string;
      status: string;
      export_transactions: { channel: string; volume_bbl: number | null }[] | null;
      allocation_id: string | null;
      batch_allocations: { channel: string } | null;
    };
  }>(() => {
    let q = supabase
      .from("invoice_line_items")
      .select(`
        id, total_cents, category, chart_of_accounts_id,
        invoices!invoice_line_items_invoice_id_fkey!inner ( id, invoice_date, status, export_transactions ( channel, volume_bbl ), allocation_id, batch_allocations!invoices_allocation_id_fkey ( channel ) )
      `)
      .neq("invoices.status", "voided")
      .lte("invoices.invoice_date", range.endDateStr)
      .order("id", { ascending: true });
    if (range.startDateStr) q = q.gte("invoices.invoice_date", range.startDateStr);
    if (cashOnly) q = q.eq("invoices.status", "paid");
    return q;
  });

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
    let exportChannel = channelSet.size === 1 ? [...channelSet][0] : null;
    // Deposit invoices (and any other allocation-linked invoice with no
    // shipment record yet) have zero export_transactions rows -- fall back to
    // the channel of the invoice's linked batch_allocations, since that's the
    // only channel signal available for them. Gated on exports.length === 0
    // (not just exportChannel === null) so a genuinely ambiguous multi-channel
    // export invoice still surfaces as "unknown" rather than being silently
    // overwritten by the allocation's channel.
    if (exports.length === 0) {
      const allocationChannel = r.invoices.batch_allocations?.channel ?? null;
      if (allocationChannel && EXPORT_CHANNELS.has(allocationChannel)) exportChannel = allocationChannel;
    }
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
      exportChannel,
      volumeBbl,
    };
  });
}

/**
 * Batch-fetches expense_gl_splits for a set of expense ids (one .in() query,
 * not one per expense) and groups them by expense_id for attachment onto
 * ExpenseRecord.splitLines. Empty map -- no query at all -- when ids is empty.
 */
async function fetchExpenseGlSplitsByExpenseId(
  supabase: SupabaseClient,
  expenseIds: string[],
): Promise<Map<string, NonNullable<ExpenseRecord["splitLines"]>>> {
  const byExpenseId = new Map<string, NonNullable<ExpenseRecord["splitLines"]>>();
  if (expenseIds.length === 0) return byExpenseId;

  const rows = await fetchAllRows<{
    expense_id: string;
    chart_of_accounts_id: string;
    amount_cents: number;
    split_source: "payroll_auto" | "manual";
  }>(() =>
    supabase
      .from("expense_gl_splits")
      .select("expense_id, chart_of_accounts_id, amount_cents, split_source")
      .in("expense_id", expenseIds)
      .order("id", { ascending: true }),
  );

  for (const r of rows) {
    const list = byExpenseId.get(r.expense_id) ?? [];
    list.push({ chartOfAccountsId: r.chart_of_accounts_id, amountCents: r.amount_cents, splitSource: r.split_source });
    byExpenseId.set(r.expense_id, list);
  }
  return byExpenseId;
}

/**
 * Batch-fetches each expense's matched pay period date range (via
 * payroll_period_expense_matches -> pay_periods), for attachment onto
 * ExpenseRecord.payrollPeriod. Two flat batched .in() queries joined in JS
 * (not a nested embed -- this codebase has been bitten before by FK-embed
 * joins breaking on non-canonical constraint names). Empty map when
 * expenseIds is empty or no expense in the set has a match.
 */
async function fetchPayrollPeriodsByExpenseId(
  supabase: SupabaseClient,
  expenseIds: string[],
): Promise<Map<string, { start: string; end: string }>> {
  const byExpenseId = new Map<string, { start: string; end: string }>();
  if (expenseIds.length === 0) return byExpenseId;

  const matchRows = await fetchAllRows<{ expense_id: string; pay_period_id: string }>(() =>
    supabase
      .from("payroll_period_expense_matches")
      .select("expense_id, pay_period_id")
      .in("expense_id", expenseIds)
      .order("expense_id", { ascending: true }),
  );
  if (matchRows.length === 0) return byExpenseId;

  const payPeriodIds = Array.from(new Set(matchRows.map((r) => r.pay_period_id)));
  const periodRows = await fetchAllRows<{ id: string; start_date: string; end_date: string }>(() =>
    supabase
      .from("pay_periods")
      .select("id, start_date, end_date")
      .in("id", payPeriodIds)
      .order("id", { ascending: true }),
  );
  const periodById = new Map(periodRows.map((p) => [p.id, { start: p.start_date, end: p.end_date }]));

  for (const m of matchRows) {
    const period = periodById.get(m.pay_period_id);
    if (period) byExpenseId.set(m.expense_id, period);
  }
  return byExpenseId;
}

export async function fetchExpenses(supabase: SupabaseClient, range: DateRange, cashOnly: boolean): Promise<ExpenseRecord[]> {
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
    return applyExpenseStatementFilters(q, cashOnly);
  });

  const expenseIds = data.map((r) => r.id);
  const [splitsByExpenseId, payrollPeriodByExpenseId] = await Promise.all([
    fetchExpenseGlSplitsByExpenseId(supabase, expenseIds),
    fetchPayrollPeriodsByExpenseId(supabase, expenseIds),
  ]);

  return data.map((r) => ({
    id: r.id,
    chartOfAccountsId: r.chart_of_accounts_id,
    amountCents: r.amount_cents ?? 0,
    accountingDate: r.accounting_date,
    mappingSource: (r.mapping_source ?? "unmapped") as ExpenseRecord["mappingSource"],
    splitLines: splitsByExpenseId.get(r.id),
    payrollPeriod: payrollPeriodByExpenseId.get(r.id) ?? null,
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

/**
 * manual_net_sales_entries, unbounded (proration against the window happens
 * downstream, per-month, in buildFinancials.ts's injectManualNetSales -- this
 * is a small, hand-maintained table, not worth a range filter).
 */
async function fetchManualNetSalesEntries(supabase: SupabaseClient): Promise<ManualNetSalesEntryRecord[]> {
  const rows = await fetchAllRows<{
    id: string;
    start_date: string;
    end_date: string;
    amount_cents: number | null;
  }>(() =>
    supabase
      .from("manual_net_sales_entries")
      .select("id, start_date, end_date, amount_cents")
      .order("id", { ascending: true }),
  );
  return rows.map((r) => ({
    id: r.id,
    startDate: r.start_date,
    endDate: r.end_date,
    amountCents: r.amount_cents ?? 0,
  }));
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

/**
 * balance_sheet mode only: payroll_gl_settings.tips_chart_of_accounts_id
 * (migration 20260823, not yet applied to prod). Degrades to null on ANY
 * error -- missing column, missing row, or any other Supabase error -- so an
 * unapplied migration never fails the financials page; it just leaves tip
 * accruals off until the setting exists.
 */
async function fetchTipsAccountId(supabase: SupabaseClient): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from("payroll_gl_settings")
      .select("tips_chart_of_accounts_id")
      .maybeSingle();
    if (error) return null;
    return (data as { tips_chart_of_accounts_id: string | null } | null)?.tips_chart_of_accounts_id ?? null;
  } catch {
    return null;
  }
}

/**
 * balance_sheet mode only: derived monthly accrual of collected card tips.
 * Sums square_orders.tip_cents where status='COMPLETED' and invoice_id is
 * null (the taproom basis -- mirrors fetchPos's own POS/invoice split)
 * across the whole cumulative range, into a single record keyed to the
 * canonical month (BS mode collapses everything onto one synthetic month
 * key, so no per-month grouping is needed here). The status filter matters
 * here specifically -- syncPosTransactions.ts keeps a CANCELED order's
 * header tip_cents intact and only withdraws its line items, so every other
 * financials source is immune to canceled orders but this one isn't without
 * it. Returns [] when tipsAccountId is null (never fail the financials page
 * over an unconfigured/not-yet-migrated setting) or when the summed tips are
 * <= 0 (a degenerate $0 row, and resolveTipAccrual's -magnitude branch would
 * sign a negative sum the same as a positive one).
 */
export async function fetchTipAccruals(
  supabase: SupabaseClient,
  range: DateRange,
  tipsAccountId: string | null,
): Promise<TipAccrualRecord[]> {
  if (!tipsAccountId) return [];

  const rows = await fetchAllRows<{ tip_cents: number | null }>(() => {
    let q = supabase
      .from("square_orders")
      .select("tip_cents")
      .eq("status", "COMPLETED")
      .is("invoice_id", null)
      .lt("transaction_date", range.end)
      .order("id", { ascending: true });
    if (range.start) q = q.gte("transaction_date", range.start);
    return q;
  });

  const amountCents = rows.reduce((s, r) => s + (r.tip_cents ?? 0), 0);
  // Degenerate guard: a would-be $0 (or negative, which shouldn't happen but
  // isn't trusted) balance-sheet row is pointless, and resolveTipAccrual's
  // -magnitude branch would sign a negative sum identically to a positive
  // one -- bail out before either can happen.
  if (amountCents <= 0) return [];
  // range.endDateStr's month IS the canonical month by construction
  // (cumulativeRange sets it to the period-end month) -- no separate
  // canonicalMonth param needed.
  const monthKey = range.endDateStr.slice(0, 7);
  return [{ id: `tips-${monthKey}`, chartOfAccountsId: tipsAccountId, amountCents, monthKey }];
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

  const [coa, pos, invoiceLines, expenses, bank, refunds, exciseCoverage, openInvoiceArCents, manualNetSalesEntries, tipAccruals] =
    await Promise.all([
      fetchCoa(supabase),
      fetchPos(supabase, range),
      fetchInvoiceLines(supabase, range, cashOnly),
      fetchExpenses(supabase, range, cashOnly),
      fetchBank(supabase, range, statement),
      fetchRefunds(supabase, range),
      fetchExciseCoverage(supabase, year),
      isBalanceSheet ? fetchOpenInvoiceAr(supabase, range.endDateStr) : Promise.resolve(0),
      // pl/cash_flow only -- balance_sheet has no analog for this P&L revenue
      // adjustment (Square parity fix B).
      isBalanceSheet ? Promise.resolve<ManualNetSalesEntryRecord[]>([]) : fetchManualNetSalesEntries(supabase),
      // balance_sheet only -- chained (not a separate `await` before
      // Promise.all) so the settings lookup stays parallel with everything
      // else instead of serializing in front of it.
      isBalanceSheet
        ? fetchTipsAccountId(supabase).then((tipsAccountId) => fetchTipAccruals(supabase, range, tipsAccountId))
        : Promise.resolve<TipAccrualRecord[]>([]),
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
      // tipAccruals already carries the canonical monthKey by construction
      // (fetchTipAccruals derives it from range.endDateStr) -- no collapseDates needed.
      tipAccruals,
      months,
      exciseCoverage,
      arAccount,
      openInvoiceArCents,
      manualNetSalesEntries,
    };
  }

  return {
    coa,
    pos,
    invoiceLines,
    expenses,
    bank,
    refunds,
    tipAccruals,
    months,
    exciseCoverage,
    arAccount,
    openInvoiceArCents,
    manualNetSalesEntries,
  };
}

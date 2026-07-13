// Aggregation core for the consolidated financials view. Pure function over
// already-fetched source records (POS lines, invoice lines, expenses,
// refunds, bank ledger) + the chart of accounts. Resolves each row's
// effective CoA (mirroring the existing per-source resolution logic — see
// header comments per source below), normalizes sign, attaches the
// orthogonal dimensions + volume (Tasks 2-3), and buckets amounts by month
// into FinancialsRow[]. No DB/Square/React imports — the fetch (including
// upstream joins like the POS account-mapping prefill, the invoice
// delivery-paid lookup, and the export_transactions channel join) happens in
// Task 6.

import type { BblCoverage, Channel, FinancialsRow, MappingSource } from "./types";
import { normalizeSignedCents } from "./normalizeSign";
import { deriveChannel, derivePosCategory, deriveKegSize } from "./dimensions";
import { rowBbl } from "./volume";
import { ACCOUNT_TYPE_SECTION } from "../accountSections";

// ─────────────────────────────────────────────────────────────────────────
// Input record types — minimal, modeled on the real table columns. Fields
// that require a join/lookup not available on the row itself (e.g. the POS
// account-mapping prefill, whether an invoice's linked delivery invoice is
// paid, or an invoice line's export channel) are precomputed upstream by
// Task 6's DB fetch and passed in as plain fields here.
// ─────────────────────────────────────────────────────────────────────────

/** pos_line_items row, joined with square_orders.invoice_id + the account-mapping prefill (app/api/finance/transactions/route.ts). */
export interface PosLineRecord {
  id: string;
  netSalesCents: number;
  /** square_orders.transaction_date (or pos_line_items' own date), "YYYY-MM-DD..." */
  transactionDate: string;
  /** pos_line_items.chart_of_accounts_id — manual override. */
  chartOfAccountsId: string | null;
  /** square_catalog_variations.chart_of_accounts_id prefill, looked up by variation id upstream. */
  prefillChartOfAccountsId: string | null;
  /** square_orders.invoice_id — null for a plain POS sale. */
  invoiceId: string | null;
  /** Whether the sold variation is an "Event Pour" catalog item (name-matched upstream). */
  isEventPour: boolean;
  /** export_transactions.channel for invoice-backed orders; null otherwise. */
  exportChannel: string | null;
  /** Variation's Square reporting-category id. */
  categoryId: string | null;
  variationName: string | null;
  quantity: number;
}

/** invoice_line_items row, joined with invoices.invoice_date + delivery-paid status + export channel (app/api/finance/statements/route.ts's resolveCoaId). */
export interface InvoiceLineRecord {
  id: string;
  totalCents: number;
  /** invoices.invoice_date, "YYYY-MM-DD". */
  invoiceDate: string;
  chartOfAccountsId: string | null;
  bsChartOfAccountsId: string | null;
  plChartOfAccountsId: string | null;
  deliveryInvoiceId: string | null;
  accountMode: "force_bs" | "force_pl" | null;
  /** Whether the linked delivery invoice (by deliveryInvoiceId) has status 'paid'. False/irrelevant when deliveryInvoiceId is null. */
  deliveryInvoicePaid: boolean;
  /** export_transactions.channel, joined via export_transactions.invoice_id = this line's invoice. */
  exportChannel: string | null;
  /**
   * export_transactions.volume_bbl for this line, when it represents a beer
   * sale; null for non-volume lines (fees, taxes, materials). Volume is
   * invoice-level, not per-line, so when an invoice has multiple
   * volume-bearing lines its total volume is concentrated on ONE
   * representative line (0 on the rest) to avoid double-counting when
   * bblByMonth sums across lines — see fetchSources.ts's fetchInvoiceLines.
   */
  volumeBbl: number | null;
}

/** expenses row — chart_of_accounts_id already resolved upstream (sync-time rule match or manual pin). */
export interface ExpenseRecord {
  id: string;
  chartOfAccountsId: string | null;
  /** Signed by cash direction: outflow negative, inflow positive. */
  amountCents: number;
  accountingDate: string | null;
  mappingSource: MappingSource;
}

/** ramp_bank_ledger row — same resolved-upstream shape as expenses. */
export interface BankLedgerRecord {
  id: string;
  chartOfAccountsId: string | null;
  /** Signed by cash direction: outflow negative, inflow positive. */
  amountCents: number;
  transactionDate: string | null;
  mappingSource: MappingSource;
}

/** square_refunds row — contra-revenue, netted against POS sales. */
export interface RefundRecord {
  id: string;
  chartOfAccountsId: string | null;
  /** Positive magnitude. */
  amountCents: number;
  refundedAt: string | null;
}

/** chart_of_accounts row. */
export interface CoaRecord {
  id: string;
  parentId: string | null;
  accountName: string;
  accountType: string;
  /** Explicit override; null = infer from accountType via ACCOUNT_TYPE_SECTION. */
  statementSection: string | null;
}

export interface AggregateRowsInput {
  pos: PosLineRecord[];
  invoiceLines: InvoiceLineRecord[];
  expenses: ExpenseRecord[];
  refunds: RefundRecord[];
  bank: BankLedgerRecord[];
  coa: CoaRecord[];
  months: string[];
}

const UNMAPPED_SECTION = "unmapped";

type NormalizeSource = "pos" | "invoice" | "expense" | "bank" | "refund";

/** One row's resolved shape, prior to grouping/month-bucketing. */
interface ResolvedRow {
  table: string;
  id: string;
  coaId: string | null;
  mappingSource: MappingSource;
  channel: Channel;
  posCategory: string | null;
  kegSize: "half" | "quarter" | "sixth" | "can" | null;
  amountCents: number;
  bbl: number;
  bblCoverage: BblCoverage;
  monthKey: string;
}

function coaSection(coa: CoaRecord | undefined): string {
  if (!coa) return UNMAPPED_SECTION;
  return coa.statementSection ?? ACCOUNT_TYPE_SECTION[coa.accountType] ?? "other";
}

function monthKeyOf(dateStr: string | null): string | null {
  if (!dateStr || dateStr.length < 7) return null;
  return dateStr.slice(0, 7);
}

function resolvePos(row: PosLineRecord, coaMap: Map<string, CoaRecord>): ResolvedRow | null {
  const monthKey = monthKeyOf(row.transactionDate);
  if (!monthKey) return null;

  const coaId = row.chartOfAccountsId ?? row.prefillChartOfAccountsId ?? null;
  const mappingSource: MappingSource = row.chartOfAccountsId
    ? "manual"
    : row.prefillChartOfAccountsId
      ? "rule"
      : "unmapped";

  const section = coaSection(coaId ? coaMap.get(coaId) : undefined);
  const kegSize = row.variationName ? deriveKegSize(row.variationName) : null;
  const { bbl, coverage } = rowBbl({
    kind: "taproom",
    categoryId: row.categoryId,
    kegSize,
    variationName: row.variationName,
    quantity: row.quantity,
    netSalesCents: row.netSalesCents,
  });

  return {
    table: "pos_line_items",
    id: row.id,
    coaId,
    mappingSource,
    channel: deriveChannel({
      invoiceId: row.invoiceId,
      isEventPour: row.isEventPour,
      exportChannel: row.exportChannel,
    }),
    posCategory: derivePosCategory({ categoryId: row.categoryId }),
    kegSize,
    amountCents: normalizeSignedCents(row.netSalesCents, section, "pos"),
    bbl,
    bblCoverage: coverage,
    monthKey,
  };
}

/** Mirrors app/api/finance/statements/route.ts's resolveCoaId deposit-recognition logic. */
function resolveInvoiceCoaId(row: InvoiceLineRecord): string | null {
  if (row.accountMode === "force_bs" && row.bsChartOfAccountsId) return row.bsChartOfAccountsId;
  if (row.accountMode === "force_pl" && row.plChartOfAccountsId) return row.plChartOfAccountsId;

  if (row.bsChartOfAccountsId && row.plChartOfAccountsId) {
    return row.deliveryInvoicePaid ? row.plChartOfAccountsId : row.bsChartOfAccountsId;
  }

  return row.chartOfAccountsId;
}

function resolveInvoice(row: InvoiceLineRecord, coaMap: Map<string, CoaRecord>): ResolvedRow | null {
  const monthKey = monthKeyOf(row.invoiceDate);
  if (!monthKey) return null;

  const coaId = resolveInvoiceCoaId(row);
  // account_mode is an explicit manual override; otherwise a resolved coaId
  // came from the sync-time mapping prefill ("rule"), and no coaId at all
  // means unmapped. Invoice lines have no separate manual-pin column like
  // POS, so "manual" here specifically tracks the force_bs/force_pl override.
  //
  // Limitation: invoice_line_items has no mapping_source column (unlike
  // expenses/ramp_bank_ledger), and its chart_of_accounts_id is user-editable
  // via a dropdown (PATCH /api/finance/ledger/invoice-line-items). So a
  // hand-mapped line and a rule/prefill-mapped line are indistinguishable
  // here — "rule" below is a best-effort label, not a verified fact. Do NOT
  // derive a manual-vs-rule signal from an invoice line's mappingSource;
  // only the mapped(coaId set) vs unmapped(coaId null) distinction is reliable.
  const mappingSource: MappingSource = row.accountMode ? "manual" : coaId ? "rule" : "unmapped";

  const section = coaSection(coaId ? coaMap.get(coaId) : undefined);
  const { bbl, coverage } =
    row.volumeBbl !== null ? rowBbl({ kind: "invoice", volumeBbl: row.volumeBbl }) : { bbl: 0, coverage: "full" as BblCoverage };

  return {
    table: "invoice_line_items",
    id: row.id,
    coaId,
    mappingSource,
    channel: deriveChannel({
      invoiceId: row.id, // any invoice line is, by definition, invoice-backed
      isEventPour: false,
      exportChannel: row.exportChannel,
    }),
    posCategory: null,
    kegSize: null,
    amountCents: normalizeSignedCents(row.totalCents, section, "invoice"),
    bbl,
    bblCoverage: coverage,
    monthKey,
  };
}

function resolveExpenseLike(
  table: string,
  id: string,
  coaId: string | null,
  mappingSource: MappingSource,
  amountCents: number,
  dateStr: string | null,
  coaMap: Map<string, CoaRecord>,
  source: NormalizeSource,
): ResolvedRow | null {
  const monthKey = monthKeyOf(dateStr);
  if (!monthKey) return null;

  const section = coaSection(coaId ? coaMap.get(coaId) : undefined);

  return {
    table,
    id,
    coaId,
    mappingSource,
    // Expenses/bank/refund rows aren't tied to a sales channel — deriveChannel's
    // inputs (invoice linkage, event-pour, export channel) don't apply to them.
    channel: "unknown",
    posCategory: null,
    kegSize: null,
    amountCents: normalizeSignedCents(amountCents, section, source),
    bbl: 0,
    bblCoverage: "full",
    monthKey,
  };
}

function groupKey(r: ResolvedRow): string {
  return [r.table, r.coaId ?? "\0null", r.channel, r.posCategory ?? "\0null", r.kegSize ?? "\0null", r.mappingSource].join("::");
}

// A group's $/BBL is withheld only when a MATERIAL share of its revenue comes
// from rows whose volume couldn't be measured (bblCoverage !== "full"). Rows
// collapse into one FinancialsRow per (table, coaId, channel, posCategory,
// kegSize, mappingSource), so a single stray unparseable row out of hundreds
// used to poison the whole group's coverage (worst-case-wins) and blank an
// otherwise-solid $/BBL. Instead we compare the unknown-coverage revenue
// against this threshold — one immaterial row no longer withholds the ratio.
const COVERAGE_UNKNOWN_THRESHOLD = 0.05; // > 5% of the group's absolute revenue → "unknown"

export function aggregateRows(input: AggregateRowsInput): FinancialsRow[] {
  const coaMap = new Map(input.coa.map((c) => [c.id, c]));
  const monthSet = new Set(input.months);

  const resolved: ResolvedRow[] = [];

  for (const row of input.pos) {
    const r = resolvePos(row, coaMap);
    if (r && monthSet.has(r.monthKey)) resolved.push(r);
  }
  for (const row of input.invoiceLines) {
    const r = resolveInvoice(row, coaMap);
    if (r && monthSet.has(r.monthKey)) resolved.push(r);
  }
  for (const row of input.expenses) {
    const r = resolveExpenseLike(
      "expenses",
      row.id,
      row.chartOfAccountsId,
      row.mappingSource,
      row.amountCents,
      row.accountingDate,
      coaMap,
      "expense",
    );
    if (r && monthSet.has(r.monthKey)) resolved.push(r);
  }
  for (const row of input.bank) {
    const r = resolveExpenseLike(
      "ramp_bank_ledger",
      row.id,
      row.chartOfAccountsId,
      row.mappingSource,
      row.amountCents,
      row.transactionDate,
      coaMap,
      "bank",
    );
    if (r && monthSet.has(r.monthKey)) resolved.push(r);
  }
  for (const row of input.refunds) {
    // square_refunds has no separate "rule" tier — its chart_of_accounts_id
    // is either set (manual/import-time pin) or null (unmapped).
    const mappingSource: MappingSource = row.chartOfAccountsId ? "manual" : "unmapped";
    const r = resolveExpenseLike(
      "square_refunds",
      row.id,
      row.chartOfAccountsId,
      mappingSource,
      row.amountCents,
      row.refundedAt,
      coaMap,
      "refund",
    );
    if (r && monthSet.has(r.monthKey)) resolved.push(r);
  }

  const groups = new Map<string, FinancialsRow>();
  // Per-group coverage materiality (decided after the loop, see COVERAGE_UNKNOWN_THRESHOLD).
  const coverageAcc = new Map<string, { total: number; unknown: number }>();

  for (const r of resolved) {
    const key = groupKey(r);
    let out = groups.get(key);
    if (!out) {
      const coa = r.coaId ? coaMap.get(r.coaId) : undefined;
      out = {
        coaId: r.coaId,
        parentId: coa?.parentId ?? null,
        accountName: coa?.accountName ?? "Unmapped",
        statementSection: coaSection(coa),
        channel: r.channel,
        posCategory: r.posCategory,
        kegSize: r.kegSize,
        amountCentsByMonth: Object.fromEntries(input.months.map((m) => [m, 0])),
        bblByMonth: Object.fromEntries(input.months.map((m) => [m, 0])),
        bblCoverage: "full",
        mappingSource: r.mappingSource,
        sourceRef: { table: r.table, ids: [] },
      };
      groups.set(key, out);
    }

    out.amountCentsByMonth[r.monthKey] = (out.amountCentsByMonth[r.monthKey] ?? 0) + r.amountCents;
    out.bblByMonth[r.monthKey] = (out.bblByMonth[r.monthKey] ?? 0) + r.bbl;
    out.sourceRef.ids.push(r.id);

    const acc = coverageAcc.get(key) ?? { total: 0, unknown: 0 };
    const mag = Math.abs(r.amountCents);
    acc.total += mag;
    if (r.bblCoverage !== "full") acc.unknown += mag;
    coverageAcc.set(key, acc);
  }

  // A group is "unknown" only when a MATERIAL share of its revenue has unmeasured
  // volume — one immaterial unparseable row no longer withholds the group's $/BBL.
  for (const [key, out] of groups) {
    const acc = coverageAcc.get(key);
    out.bblCoverage =
      acc && acc.total > 0 && acc.unknown / acc.total > COVERAGE_UNKNOWN_THRESHOLD ? "unknown" : "full";
  }

  return [...groups.values()];
}

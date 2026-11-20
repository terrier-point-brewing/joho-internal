// Lays the bookkeeper export out as spreadsheet tabs. Pure: everything it
// needs arrives already fetched (see fetchExportData.ts), so the layout is
// testable without a database.
//
// The three statement tabs are NOT recomputed here. They are the same
// FinancialsResponse the Financials screen renders, walked through the same
// buildTree, so a figure in the workbook is the figure on screen.

import { buildTree, type TreeNode } from "@/app/finance/financials/buildTree";
import { SECTION_LABEL } from "@/app/finance/financials/controls";
import { CHANNEL_LABEL } from "@/app/finance/financials/channelColors";
import { coaSection, type CoaRecord } from "@/lib/finance/financials/aggregateRows";
import { presentationTotal, statementTotal, totalColumnLabel, totalModeFor } from "@/lib/finance/financials/statementTotal";
import type { Channel, FinancialsResponse, StatementKind } from "@/lib/finance/financials/types";
import type { StatementSection } from "@/lib/finance/accountSections";
import { debitCredit, type DerivedLine, type Posting, type PostingSource, type TieDifference } from "./postings";
import type { Cell, CellStyle, Sheet } from "./xlsx";

// ── inputs ──────────────────────────────────────────────────────────────────

/** Chart of accounts with the descriptive columns the statements never needed. */
export interface CoaDetail extends CoaRecord {
  detailType: string | null;
  description: string | null;
  isActive: boolean;
}

/** The human-readable half of a posting, looked up by its record id. */
export interface PostingDetail {
  description: string;
  counterparty: string;
  reference: string;
}

export interface OpenInvoice {
  invoiceNumber: string | null;
  invoiceDate: string;
  dueDate: string | null;
  customerName: string | null;
  status: string;
  totalCents: number;
}

export interface OpenBill {
  vendor: string | null;
  billDate: string;
  memo: string | null;
  accountId: string | null;
  /** Positive: what is owed. */
  amountCents: number;
}

export interface ManualEntryRow {
  kind: string;
  label: string | null;
  accountId: string | null;
  startDate: string | null;
  endDate: string | null;
  asOfDate: string | null;
  amountCents: number;
  note: string | null;
}

export interface ExportData {
  year: number;
  /** ISO timestamp of the export. */
  generatedAt: string;
  /** "YYYY-MM-DD": the last day of the period -- the "as of" date for the open-item tabs. */
  asOfDate: string;
  pl: FinancialsResponse;
  balanceSheet: FinancialsResponse;
  cashFlow: FinancialsResponse;
  coa: CoaDetail[];
  postings: Posting[];
  derived: DerivedLine[];
  differences: TieDifference[];
  details: Map<string, PostingDetail>;
  openInvoices: OpenInvoice[];
  openBills: OpenBill[];
  manualEntries: ManualEntryRow[];
}

// ── small helpers ───────────────────────────────────────────────────────────

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-03" -> "Mar 2026". */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${MONTH_NAMES[m - 1] ?? month} ${y}`;
}

/** Last calendar day of a "YYYY-MM" month, as "YYYY-MM-DD". */
export function monthEndDate(month: string): string {
  const [y, m] = month.split("-").map(Number);
  // Day 0 of the next month, in UTC so no local zone can move it.
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, "0")}`;
}

function dollars(cents: number): number {
  return cents / 100;
}

function money(cents: number | null | undefined, style: CellStyle = "money"): Cell {
  return cents === null || cents === undefined ? null : { v: dollars(cents), s: style };
}

function header(labels: string[]): Cell[] {
  return labels.map((v) => ({ v, s: "bold" as const }));
}

function sectionLabel(section: string): string {
  return SECTION_LABEL[section as StatementSection] ?? (section === "unmapped" ? "Unmapped" : section);
}

/** Sorts by GL number (numeric where possible), accounts without one last. */
function byAccountNumber<T>(numberOf: (item: T) => string | null): (a: T, b: T) => number {
  return (a, b) => {
    const an = numberOf(a);
    const bn = numberOf(b);
    if (an === bn) return 0;
    if (an === null) return 1;
    if (bn === null) return -1;
    return an.localeCompare(bn, undefined, { numeric: true });
  };
}

// ── statement tabs ──────────────────────────────────────────────────────────

const STATEMENT_TITLE: Record<StatementKind, string> = {
  pl: "Profit & Loss",
  balance_sheet: "Balance Sheet",
  cash_flow: "Cash Flow",
};

const STATEMENT_NOTE: Record<StatementKind, string> = {
  pl: "Accrual basis. An account with sub-accounts shows the total of everything under it; the indented lines below it are its breakdown, not additions to it.",
  balance_sheet: "Month-end balances. The Balance column is the closing balance of the last month shown, not a sum.",
  cash_flow: "Cash basis (direct method): money that actually moved in each month.",
};

/**
 * Walks the screen's tree into flat rows. Sub-accounts are kept; channel
 * slices and manual-adjustment breakouts are dropped, because each is a
 * decomposition of the account line above it (same account, shown again) and
 * a reader summing the column would count the money twice.
 */
function flattenTree(
  nodes: TreeNode[],
  months: string[],
  statement: StatementKind,
  numberById: Map<string, string | null>,
  parent: TreeNode | null,
  out: Cell[][],
): void {
  const mode = totalModeFor(statement);
  for (const node of nodes) {
    const sameAccountAsParent =
      parent !== null && parent.depth > 0 && node.row !== null && node.row.coaId === (parent.row?.coaId ?? null);
    if (node.isAdjustment || sameAccountAsParent) continue;

    const label = `${"    ".repeat(node.depth)}${node.label}`;
    const emphasis: "bold" | "italic" | "text" = node.isMemo || node.isRatio ? "italic" : node.depth === 0 ? "bold" : "text";

    if (node.isRatio) {
      const pct = (value: number | null | undefined): Cell =>
        value === null || value === undefined ? null : { v: value / 100, s: "percentItalic" };
      out.push([{ v: label, s: "italic" }, null, ...months.map((m) => pct(node.ratioByMonth?.[m])), pct(node.ratioTotal)]);
    } else if (node.row === null) {
      out.push([{ v: label, s: emphasis }]);
    } else {
      const moneyStyle: CellStyle = emphasis === "bold" ? "moneyBold" : emphasis === "italic" ? "moneyItalic" : "money";
      const glNumber = node.depth > 0 && node.row.coaId ? (numberById.get(node.row.coaId) ?? null) : null;
      const byMonth = node.row.amountCentsByMonth;
      out.push([
        { v: label, s: emphasis },
        glNumber,
        ...months.map((m) => money(byMonth[m] ?? 0, moneyStyle)),
        money(statementTotal(byMonth, months, mode), moneyStyle),
      ]);
    }

    flattenTree(node.children, months, statement, numberById, node, out);
  }
}

function statementSheet(statement: StatementKind, response: FinancialsResponse, numberById: Map<string, string | null>): Sheet {
  const { months } = response;
  const body: Cell[][] = [];
  flattenTree(buildTree(response.rows, statement, response.coaAccounts), months, statement, numberById, null, body);
  return {
    name: STATEMENT_TITLE[statement],
    freezeRows: 3,
    widths: [48, 9, ...months.map(() => 14), 15],
    rows: [
      [{ v: STATEMENT_TITLE[statement], s: "bold" }],
      [{ v: STATEMENT_NOTE[statement], s: "italic" }],
      header(["Account", "GL #", ...months.map(monthLabel), totalColumnLabel(totalModeFor(statement))]),
      ...body,
    ],
  };
}

// ── account summary ─────────────────────────────────────────────────────────

const PL_SECTIONS: ReadonlySet<string> = new Set(["revenue", "other_income", "cogs", "expenses", "other_expense"]);

function accountSummarySheet(data: ExportData): Sheet {
  const plMonths = data.pl.months;
  const bsMonths = data.balanceSheet.months;

  const activity = new Map<string, number>();
  for (const row of data.pl.rows) {
    if (row.coaId === null) continue;
    activity.set(row.coaId, (activity.get(row.coaId) ?? 0) + statementTotal(row.amountCentsByMonth, plMonths, "sum"));
  }
  const closing = new Map<string, number>();
  for (const row of data.balanceSheet.rows) {
    if (row.coaId === null) continue;
    closing.set(row.coaId, (closing.get(row.coaId) ?? 0) + presentationTotal(row.amountCentsByMonth, bsMonths, "closing", row.statementSection));
  }

  const rows: Cell[][] = [];
  for (const account of [...data.coa].sort(byAccountNumber((c) => c.accountNumber))) {
    const section = coaSection(account);
    const isPl = PL_SECTIONS.has(section);
    const periodActivity = isPl ? activity.get(account.id) : undefined;
    const closingBalance = isPl ? undefined : closing.get(account.id);
    if (periodActivity === undefined && closingBalance === undefined) continue;
    rows.push([account.accountNumber, account.accountName, account.accountType, sectionLabel(section), money(periodActivity), money(closingBalance)]);
  }

  const lastBsMonth = bsMonths[bsMonths.length - 1];
  return {
    name: "Account Summary",
    freezeRows: 3,
    widths: [9, 44, 26, 26, 18, 18],
    rows: [
      [{ v: "Account Summary", s: "bold" }],
      [{
        v: "One line per account with a figure. Income and cost accounts show their own activity for the period (income positive, cost negative; sub-accounts are NOT rolled into their parent here). Balance-sheet accounts show the closing balance. This is not a debit/credit trial balance: the app keeps no double-entry journal.",
        s: "italic",
      }],
      header([
        "GL #",
        "Account",
        "Type",
        "Section",
        `Activity ${monthLabel(plMonths[0])} - ${monthLabel(plMonths[plMonths.length - 1])}`,
        `Balance at ${lastBsMonth ? monthEndDate(lastBsMonth) : ""}`,
      ]),
      ...rows,
    ],
  };
}

// ── GL detail ───────────────────────────────────────────────────────────────

const SOURCE_LABEL: Record<PostingSource, string> = {
  pos_line_items: "Square sale",
  invoice_line_items: "Invoice",
  expenses: "Expense / bill",
  bank_ledger: "Bank",
  square_refunds: "Refund",
};

const MAPPING_LABEL: Record<string, string> = { manual: "Set by hand", rule: "Rule", unmapped: "Unmapped" };

interface DetailLine {
  date: string;
  month: string;
  coaId: string | null;
  source: string;
  description: string;
  counterparty: string;
  reference: string;
  channel: string;
  mapping: string;
  amountCents: number;
}

/**
 * A derived statement row is named "<account> (<what it is>)". The account is
 * already its own column on GL Detail, so only the second half is worth a
 * description: "Cost of beer sold", not the account's name twice.
 */
export function derivedDescription(rowName: string, accountName: string | undefined): string {
  if (!accountName || !rowName.startsWith(accountName)) return rowName;
  const rest = rowName.slice(accountName.length).trim();
  const unwrapped = rest.replace(/^\((.*)\)$/, "$1");
  return unwrapped.length > 0 ? unwrapped : rowName;
}

function glDetailSheet(data: ExportData): Sheet {
  const accountById = new Map(data.coa.map((c) => [c.id, c]));

  const lines: DetailLine[] = [];
  for (const p of data.postings) {
    const detail = data.details.get(p.recordId);
    lines.push({
      date: p.date,
      month: p.month,
      coaId: p.coaId,
      source: SOURCE_LABEL[p.source],
      description: detail?.description ?? "",
      counterparty: detail?.counterparty ?? "",
      reference: detail?.reference ?? "",
      channel: p.channel === "unknown" ? "" : (CHANNEL_LABEL[p.channel as Channel] ?? p.channel),
      // No account is "Unmapped" whatever the row's own flag says: a bank line
      // someone deliberately left without an account still has none.
      mapping: p.coaId === null ? MAPPING_LABEL.unmapped : (MAPPING_LABEL[p.mappingSource] ?? p.mappingSource),
      amountCents: p.amountCents,
    });
  }
  for (const d of data.derived) {
    const manual = d.basis === "manual_entries";
    lines.push({
      date: monthEndDate(d.month),
      month: d.month,
      coaId: d.coaId,
      source: manual ? "Manual entry" : "Calculated",
      description: derivedDescription(d.description, accountById.get(d.coaId)?.accountName),
      counterparty: "",
      reference: "",
      channel: "",
      mapping: manual ? "Set by hand" : "Rule",
      amountCents: d.amountCents,
    });
  }
  // A difference is listed as its own line rather than hidden, so the tab
  // still adds up to the statement and the gap has a visible size and place.
  for (const diff of data.differences) {
    lines.push({
      date: monthEndDate(diff.month),
      month: diff.month,
      coaId: diff.coaId,
      source: "Unreconciled",
      description: "Difference between the statement and the lines listed for this account and month",
      counterparty: "",
      reference: "",
      channel: "",
      mapping: "",
      amountCents: diff.statementCents - diff.detailCents,
    });
  }

  const numberOf = (line: DetailLine) => (line.coaId ? (accountById.get(line.coaId)?.accountNumber ?? null) : null);
  const compareNumber = byAccountNumber<DetailLine>(numberOf);
  lines.sort(
    (a, b) =>
      compareNumber(a, b) ||
      (a.coaId ?? "").localeCompare(b.coaId ?? "") ||
      a.month.localeCompare(b.month) ||
      a.date.localeCompare(b.date),
  );

  const rows: Cell[][] = lines.map((line) => {
    const account = line.coaId ? accountById.get(line.coaId) : undefined;
    const section = account ? coaSection(account) : "unmapped";
    const { debitCents, creditCents } = debitCredit(line.amountCents, section);
    return [
      line.date,
      line.month,
      account?.accountNumber ?? null,
      account?.accountName ?? "Unmapped",
      sectionLabel(section),
      line.source,
      line.description,
      line.counterparty,
      line.reference,
      line.channel,
      line.mapping,
      debitCents ? money(debitCents) : null,
      creditCents ? money(creditCents) : null,
      money(line.amountCents),
    ];
  });

  return {
    name: "GL Detail",
    freezeRows: 3,
    widths: [11, 9, 8, 36, 22, 14, 44, 28, 20, 16, 12, 13, 13, 14],
    rows: [
      [{ v: "GL Detail", s: "bold" }],
      [{
        v: "Every line behind the Profit & Loss, grouped by account. Period is the month the amount lands in on the statement (a payroll run is spread over its pay period, so it can differ from Date). Debit / Credit is this account's side only: the app records no offsetting entry. Amount is as the statement shows it: income positive, cost negative.",
        s: "italic",
      }],
      header(["Date", "Period", "GL #", "Account", "Section", "Source", "Description", "Counterparty", "Reference", "Channel", "Account set by", "Debit", "Credit", "Amount"]),
      ...rows,
    ],
  };
}

// ── supporting tabs ─────────────────────────────────────────────────────────

function chartOfAccountsSheet(data: ExportData): Sheet {
  const byId = new Map(data.coa.map((c) => [c.id, c]));
  const rows: Cell[][] = [...data.coa].sort(byAccountNumber((c) => c.accountNumber)).map((c) => {
    const parent = c.parentId ? byId.get(c.parentId) : undefined;
    return [
      c.accountNumber,
      c.accountName,
      c.accountType,
      c.detailType,
      sectionLabel(coaSection(c)),
      parent ? [parent.accountNumber, parent.accountName].filter(Boolean).join(" ") : null,
      c.isActive ? "Yes" : "No",
      c.description,
    ];
  });
  return {
    name: "Chart of Accounts",
    freezeRows: 1,
    widths: [9, 44, 26, 28, 26, 40, 8, 50],
    rows: [header(["GL #", "Account", "Type", "Detail type", "Statement section", "Parent account", "Active", "Description"]), ...rows],
  };
}

function openInvoicesSheet(data: ExportData): Sheet {
  const rows: Cell[][] = [...data.openInvoices]
    .sort((a, b) => a.invoiceDate.localeCompare(b.invoiceDate))
    .map((i) => [i.invoiceNumber, i.invoiceDate, i.dueDate, i.customerName, i.status, money(i.totalCents)]);
  const total = data.openInvoices.reduce((sum, i) => sum + i.totalCents, 0);
  return {
    name: "Open Invoices",
    freezeRows: 3,
    widths: [14, 12, 12, 40, 12, 15],
    rows: [
      [{ v: `Open invoices as of ${data.asOfDate}`, s: "bold" }],
      [{ v: "Invoices raised on or before this date and not paid by it, at their invoiced total. The same rule Accounts Receivable on the balance sheet uses.", s: "italic" }],
      header(["Invoice #", "Invoice date", "Due date", "Customer", "Status", "Invoice total"]),
      ...rows,
      [],
      [{ v: "Total", s: "bold" }, null, null, null, null, money(total, "moneyBold")],
    ],
  };
}

function openBillsSheet(data: ExportData): Sheet {
  const accountById = new Map(data.coa.map((c) => [c.id, c]));
  const rows: Cell[][] = [...data.openBills]
    .sort((a, b) => a.billDate.localeCompare(b.billDate))
    .map((b) => {
      const account = b.accountId ? accountById.get(b.accountId) : undefined;
      return [b.vendor, b.billDate, account?.accountNumber ?? null, account?.accountName ?? (b.accountId ? null : "Unmapped"), b.memo, money(b.amountCents)];
    });
  const total = data.openBills.reduce((sum, b) => sum + b.amountCents, 0);
  return {
    name: "Open Bills",
    freezeRows: 3,
    widths: [36, 12, 8, 36, 50, 15],
    rows: [
      [{ v: `Open bills as of ${data.asOfDate}`, s: "bold" }],
      [{ v: "Ramp Bill Pay bills received on or before this date and not paid by it. The same rule Accounts Payable on the balance sheet uses.", s: "italic" }],
      header(["Vendor", "Bill date", "GL #", "Account", "Memo", "Amount owed"]),
      ...rows,
      [],
      [{ v: "Total", s: "bold" }, null, null, null, null, money(total, "moneyBold")],
    ],
  };
}

function manualEntriesSheet(data: ExportData): Sheet {
  const accountById = new Map(data.coa.map((c) => [c.id, c]));
  const rows: Cell[][] = [...data.manualEntries]
    .sort((a, b) => (a.startDate ?? a.asOfDate ?? "").localeCompare(b.startDate ?? b.asOfDate ?? ""))
    .map((e) => {
      const account = e.accountId ? accountById.get(e.accountId) : undefined;
      return [
        e.kind,
        e.label,
        account?.accountNumber ?? null,
        account?.accountName ?? null,
        e.startDate,
        e.endDate,
        e.asOfDate,
        money(e.amountCents),
        e.note,
      ];
    });
  return {
    name: "Manual Entries",
    freezeRows: 3,
    widths: [10, 36, 8, 36, 12, 12, 12, 15, 60],
    rows: [
      [{ v: "Manual entries", s: "bold" }],
      [{ v: "Every entry a person typed in rather than a feed supplying it, all dates. A dated range is spread evenly over its days on the Profit & Loss.", s: "italic" }],
      header(["Kind", "Label", "GL #", "Account", "Start", "End", "As of", "Amount", "Note"]),
      ...rows,
    ],
  };
}

// ── summary ─────────────────────────────────────────────────────────────────

function findNode(nodes: TreeNode[], label: string): TreeNode | null {
  for (const node of nodes) {
    if (node.label === label) return node;
    const hit = findNode(node.children, label);
    if (hit) return hit;
  }
  return null;
}

function summarySheet(data: ExportData): Sheet {
  const months = data.pl.months;
  const period = `${monthLabel(months[0])} to ${monthLabel(months[months.length - 1])}`;

  const tieCents = data.differences.reduce((sum, d) => sum + Math.abs(d.statementCents - d.detailCents), 0);
  const tie: Cell[] =
    data.differences.length === 0
      ? ["GL Detail adds up to the Profit & Loss", "Yes, for every account in every month"]
      : ["GL Detail adds up to the Profit & Loss", `No: ${data.differences.length} account-months differ. Each is listed on GL Detail as "Unreconciled".`, money(tieCents)];

  const bsMonths = data.balanceSheet.months;
  const closingMonth = bsMonths[bsMonths.length - 1];
  const diffNode = findNode(buildTree(data.balanceSheet.rows, "balance_sheet", data.balanceSheet.coaAccounts), "Balancing Difference");
  const balancingCents = diffNode?.row && closingMonth ? (diffNode.row.amountCentsByMonth[closingMonth] ?? 0) : null;
  const balancing: Cell[] =
    balancingCents === null
      ? ["Balance sheet balances", "Not available"]
      : balancingCents === 0
        ? ["Balance sheet balances", `Yes, at ${monthEndDate(closingMonth)}`]
        : ["Balance sheet balances", `No: assets and liabilities + equity differ at ${monthEndDate(closingMonth)} by`, money(balancingCents)];

  // Counted from the lines GL Detail actually lists, so the figure here is
  // the one a reader gets by summing the Unmapped block at the end of that tab.
  const unmapped = data.postings.filter((p) => p.coaId === null);
  const unmappedCents = unmapped.reduce((sum, p) => sum + p.amountCents, 0);
  const mapped: Cell[] =
    unmapped.length === 0
      ? ["Every transaction has an account", "Yes"]
      : ["Every transaction has an account", `No: ${unmapped.length} lines have no account. They are listed at the end of GL Detail and net to`, money(unmappedCents)];

  const tabs: [string, string][] = [
    ["Profit & Loss", "Income and costs by month, accrual basis."],
    ["Balance Sheet", "Month-end balances for every asset, liability and equity account."],
    ["Cash Flow", "Money that actually moved, by month."],
    ["Account Summary", "One line per account: period activity or closing balance."],
    ["GL Detail", "Every transaction behind the Profit & Loss, by account, with debit and credit."],
    ["Chart of Accounts", "The full account list."],
    ["Open Invoices", "Customer invoices owed at the end of the period (receivables)."],
    ["Open Bills", "Vendor bills owed at the end of the period (payables)."],
    ["Manual Entries", "Everything typed in by hand."],
  ];

  return {
    name: "Summary",
    widths: [40, 70, 16],
    rows: [
      [{ v: "Bookkeeper export", s: "bold" }],
      ["Period", period],
      ["Generated", data.generatedAt],
      ["Open items as of", data.asOfDate],
      [],
      [{ v: "Checks", s: "bold" }],
      tie,
      balancing,
      mapped,
      [],
      [{ v: "What is in this workbook", s: "bold" }],
      ...tabs.map(([name, what]): Cell[] => [name, what]),
      [],
      [{ v: "How to read it", s: "bold" }],
      ["Source", "Statements are computed from the source records (Square, invoices, Ramp, bank feeds, payroll) each time. There is no double-entry journal, so there are no offsetting entries to export."],
      ["Months not closed", "A month that has not been closed in Period Close is still live and can change as feeds catch up."],
      ["Calculated lines", "Depreciation, inventory capitalised and relieved, cost of beer sold, excise accrued and card processing fees are calculated monthly rather than booked per transaction. They appear on GL Detail as one line per account per month."],
      ["Signs", "Statements show income positive and costs negative. Balance-sheet liabilities and equity are shown positive."],
    ],
  };
}

// ── entry point ─────────────────────────────────────────────────────────────

export function buildExportSheets(data: ExportData): Sheet[] {
  const numberById = new Map(data.coa.map((c) => [c.id, c.accountNumber]));
  return [
    summarySheet(data),
    statementSheet("pl", data.pl, numberById),
    statementSheet("balance_sheet", data.balanceSheet, numberById),
    statementSheet("cash_flow", data.cashFlow, numberById),
    accountSummarySheet(data),
    glDetailSheet(data),
    chartOfAccountsSheet(data),
    openInvoicesSheet(data),
    openBillsSheet(data),
    manualEntriesSheet(data),
  ];
}

// Pure tree builder for the consolidated financials view (Task 9). Turns a
// flat FinancialsRow[] into the section/account/slice hierarchy the single
// FinancialsTable renderer walks. Generalizes app/finance/statements/lib.tsx's
// buildTree (parent/child COA accounts) plus SectionRows/SubtotalRow (section
// totals, cross-section rollups) into one data structure, and adds a new
// concern neither predecessor had: nesting channel slice rows under an
// account so a single account can show its taproom/distribution/etc. split.
//
// No DB/Square/React imports -- pure over already-fetched FinancialsRow[].
//
// ── Design invariant (read before editing) ─────────────────────────────────
// Every node's `row`, when non-null, already holds the FULLY ROLLED-UP total
// for that node's entire subtree (own postings + all descendants). Callers
// (FinancialsTable) NEVER sum `row` + `children` -- they display `row`
// directly and separately render `children` as an expandable detail/decomposition
// view. This one invariant covers three structurally different cases without
// needing extra discriminant fields beyond the brief's fixed TreeNode shape:
//   - a section's row is the sum of all its root accounts (additive)
//   - an account's row is its own postings + all descendant sub-accounts
//     (additive, since a parent/child COA pair are different coaIds)
//   - a channel-slice's row is a straight subset of its account's own
//     postings (a decomposition, not additive on top of the account)
// A node's `label` doubles as a lightweight kind discriminant at render time:
// depth 0 + isSection -> section header; depth 0 + !isSection -> a top-level
// subtotal (Total Income, Gross Profit, ...); depth > 0 -> account or slice.

import type { BblCoverage, FinancialsRow, StatementKind } from "@/lib/finance/financials/types";
import { CHANNEL_LABEL } from "./channelColors";

export interface TreeNode {
  row: FinancialsRow | null;
  label: string;
  children: TreeNode[];
  depth: number;
  isSection: boolean;
}

const COVERAGE_RANK: Record<BblCoverage, number> = { full: 0, partial: 1, unknown: 2 };

function worstCoverage(a: BblCoverage, b: BblCoverage): BblCoverage {
  return COVERAGE_RANK[b] > COVERAGE_RANK[a] ? b : a;
}

/** Sums amountCentsByMonth/bblByMonth across `rows` per month, keeping a `meta` shape (coaId/parentId/accountName/section/channel) supplied by the caller. Used both to combine one account's own multi-channel rows and to roll a parent account's own total up with its children's already-rolled totals. */
function sumRows(
  rows: FinancialsRow[],
  months: string[],
  meta: Pick<FinancialsRow, "coaId" | "parentId" | "accountName" | "statementSection" | "channel">,
): FinancialsRow {
  const amountCentsByMonth: Record<string, number> = {};
  const bblByMonth: Record<string, number> = {};
  for (const m of months) {
    amountCentsByMonth[m] = rows.reduce((s, r) => s + (r.amountCentsByMonth[m] ?? 0), 0);
    bblByMonth[m] = rows.reduce((s, r) => s + (r.bblByMonth[m] ?? 0), 0);
  }
  let bblCoverage: BblCoverage = "full";
  const ids: string[] = [];
  let table = "";
  for (const r of rows) {
    bblCoverage = worstCoverage(bblCoverage, r.bblCoverage);
    ids.push(...r.sourceRef.ids);
    if (!table) table = r.sourceRef.table;
  }
  return {
    ...meta,
    posCategory: null,
    kegSize: null,
    amountCentsByMonth,
    bblByMonth,
    bblCoverage,
    mappingSource: "rule",
    sourceRef: { table, ids },
  };
}

/** Rolls up a list of already-built nodes' `.row` totals into one synthetic FinancialsRow (used for section totals and top-level subtotals). */
function sumNodeRows(nodes: TreeNode[], months: string[], label: string, statementSection: string): FinancialsRow {
  const rows = nodes.map((n) => n.row).filter((r): r is FinancialsRow => r !== null);
  return sumRows(rows, months, {
    coaId: null,
    parentId: null,
    accountName: label,
    statementSection,
    channel: "unknown",
  });
}

function accountKey(row: FinancialsRow): string {
  return row.coaId ?? `unmapped:${row.accountName}`;
}

/** Builds one account node (and its channel-slice + child-account descendants) for a single coaId (or unmapped bucket) within a section. */
function buildAccountNode(
  key: string,
  rowsByAccount: Map<string, FinancialsRow[]>,
  childKeysByParent: Map<string, string[]>,
  months: string[],
  depth: number,
): TreeNode {
  const ownRows = rowsByAccount.get(key)!;
  const first = ownRows[0];

  const childKeys = childKeysByParent.get(key) ?? [];
  const childAccountNodes = childKeys.map((childKey) =>
    buildAccountNode(childKey, rowsByAccount, childKeysByParent, months, depth + 1),
  );

  const distinctChannels = [...new Set(ownRows.map((r) => r.channel))];
  const sliceNodes: TreeNode[] =
    distinctChannels.length > 1
      ? distinctChannels
          .sort()
          .map((channel) => {
            const channelRows = ownRows.filter((r) => r.channel === channel);
            const sliceRow = sumRows(channelRows, months, {
              coaId: first.coaId,
              parentId: first.parentId,
              accountName: first.accountName,
              statementSection: first.statementSection,
              channel,
            });
            return {
              row: sliceRow,
              label: CHANNEL_LABEL[channel],
              children: [],
              depth: depth + 1,
              isSection: false,
            };
          })
      : [];

  const ownTotalRow = sumRows(ownRows, months, {
    coaId: first.coaId,
    parentId: first.parentId,
    accountName: first.accountName,
    statementSection: first.statementSection,
    channel: distinctChannels.length === 1 ? distinctChannels[0] : "unknown",
  });

  const rolledRow =
    childAccountNodes.length > 0
      ? sumRows([ownTotalRow, ...childAccountNodes.map((n) => n.row).filter((r): r is FinancialsRow => r !== null)], months, {
          coaId: first.coaId,
          parentId: first.parentId,
          accountName: first.accountName,
          statementSection: first.statementSection,
          channel: ownTotalRow.channel,
        })
      : ownTotalRow;

  return {
    row: rolledRow,
    label: first.accountName,
    children: [...childAccountNodes, ...sliceNodes],
    depth,
    isSection: false,
  };
}

/** Builds a top-level section node (Revenue, COGS, Bank & Cash, ...): groups the section's rows into a parent/child account tree, and rolls all root accounts up into the section's own `.row` total. */
function buildSection(rows: FinancialsRow[], statementSection: string, label: string, months: string[]): TreeNode {
  const sectionRows = rows.filter((r) => r.statementSection === statementSection);

  const rowsByAccount = new Map<string, FinancialsRow[]>();
  for (const row of sectionRows) {
    const key = accountKey(row);
    const bucket = rowsByAccount.get(key);
    if (bucket) bucket.push(row);
    else rowsByAccount.set(key, [row]);
  }

  const parentKeyOf = (key: string): string | null => {
    const parentId = rowsByAccount.get(key)![0].parentId;
    return parentId && rowsByAccount.has(parentId) ? parentId : null;
  };

  const childKeysByParent = new Map<string, string[]>();
  const rootKeys: string[] = [];
  for (const key of rowsByAccount.keys()) {
    const parentKey = parentKeyOf(key);
    if (parentKey === null) {
      rootKeys.push(key);
    } else {
      const bucket = childKeysByParent.get(parentKey);
      if (bucket) bucket.push(key);
      else childKeysByParent.set(parentKey, [key]);
    }
  }

  const accountNodes = rootKeys.map((key) => buildAccountNode(key, rowsByAccount, childKeysByParent, months, 1));

  return {
    row: sumNodeRows(accountNodes, months, label, statementSection),
    label,
    children: accountNodes,
    depth: 0,
    isSection: true,
  };
}

/** Builds a top-level subtotal row (Total Income, Gross Profit, Net Income, ...) by summing the given sections' already-rolled `.row` totals. Carries no children -- its constituent sections already render their own detail above it. */
function subtotal(label: string, sections: TreeNode[], months: string[]): TreeNode {
  return {
    row: sumNodeRows(sections, months, label, "other"),
    label,
    children: [],
    depth: 0,
    isSection: false,
  };
}

function monthsOf(rows: FinancialsRow[]): string[] {
  return rows.length > 0 ? Object.keys(rows[0].amountCentsByMonth) : [];
}

function buildPl(rows: FinancialsRow[], months: string[]): TreeNode[] {
  const revenue = buildSection(rows, "revenue", "Revenue", months);
  const otherIncome = buildSection(rows, "other_income", "Other Income", months);
  const totalIncome = subtotal("Total Income", [revenue, otherIncome], months);

  const cogs = buildSection(rows, "cogs", "Cost of Goods Sold", months);
  // Gross Profit excludes Other Income by convention -- and must match the
  // grossMarginPct KPI (lib/finance/financials/summaries.ts), which is
  // (revenue - cogs) / revenue with no other_income term. Total Income above
  // still includes other_income; Net Income below still includes everything.
  // See spec §7 (KPI and statement must never disagree) + Task 15 final
  // review, finding I1.
  const grossProfit = subtotal("Gross Profit", [revenue, cogs], months);

  const opEx = buildSection(rows, "expenses", "Operating Expenses", months);
  const otherExp = buildSection(rows, "other_expense", "Other Expenses", months);
  const netIncome = subtotal("Net Income", [revenue, otherIncome, cogs, opEx, otherExp], months);

  return [revenue, otherIncome, totalIncome, cogs, grossProfit, opEx, otherExp, netIncome];
}

function buildCashFlow(rows: FinancialsRow[], months: string[]): TreeNode[] {
  const revenue = buildSection(rows, "revenue", "Cash Collected — Revenue", months);
  const otherIncome = buildSection(rows, "other_income", "Cash Collected — Other Income", months);
  const totalCashIn = subtotal("Total Cash In", [revenue, otherIncome], months);

  const cogs = buildSection(rows, "cogs", "Cash Paid — Cost of Goods Sold", months);
  const opEx = buildSection(rows, "expenses", "Cash Paid — Operating Expenses", months);
  const otherExp = buildSection(rows, "other_expense", "Cash Paid — Other Expenses", months);
  const totalCashOut = subtotal("Total Cash Out", [cogs, opEx, otherExp], months);

  const netOperating = subtotal("Net Operating", [revenue, otherIncome, cogs, opEx, otherExp], months);

  return [revenue, otherIncome, totalCashIn, cogs, opEx, otherExp, totalCashOut, netOperating];
}

function buildBalanceSheet(rows: FinancialsRow[], months: string[]): TreeNode[] {
  const bank = buildSection(rows, "bank", "Bank & Cash", months);
  const ar = buildSection(rows, "ar", "Accounts Receivable", months);
  const otherCurrentAssets = buildSection(rows, "other_current_assets", "Other Current Assets", months);
  const totalCurrentAssets = subtotal("Total Current Assets", [bank, ar, otherCurrentAssets], months);
  const fixedAssets = buildSection(rows, "fixed_assets", "Fixed Assets", months);
  const totalAssets = subtotal("Total Assets", [bank, ar, otherCurrentAssets, fixedAssets], months);

  const ap = buildSection(rows, "ap", "Accounts Payable", months);
  const creditCard = buildSection(rows, "credit_card", "Credit Cards", months);
  const otherCurrentLiab = buildSection(rows, "other_current_liabilities", "Other Current Liabilities", months);
  const totalCurrentLiab = subtotal("Total Current Liabilities", [ap, creditCard, otherCurrentLiab], months);
  const longTermLiab = buildSection(rows, "long_term_liabilities", "Long-Term Liabilities", months);
  const totalLiab = subtotal("Total Liabilities", [ap, creditCard, otherCurrentLiab, longTermLiab], months);

  const equity = buildSection(rows, "equity", "Equity", months);
  const totalLiabEquity = subtotal(
    "Total Liabilities + Equity",
    [ap, creditCard, otherCurrentLiab, longTermLiab, equity],
    months,
  );

  return [
    bank, ar, otherCurrentAssets, totalCurrentAssets, fixedAssets, totalAssets,
    ap, creditCard, otherCurrentLiab, totalCurrentLiab, longTermLiab, totalLiab,
    equity, totalLiabEquity,
  ];
}

export function buildTree(rows: FinancialsRow[], statement: StatementKind): TreeNode[] {
  const months = monthsOf(rows);
  if (statement === "balance_sheet") return buildBalanceSheet(rows, months);
  if (statement === "cash_flow") return buildCashFlow(rows, months);
  return buildPl(rows, months);
}

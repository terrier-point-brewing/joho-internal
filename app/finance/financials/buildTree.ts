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

/**
 * CoA sub-accounts conventionally repeat their parent's full name as a
 * prefix (e.g. "Utilities:Electric", "Utilities - Electric") so the QuickBooks
 * "By Type" flat view stays self-describing. In this tree, the parent is
 * already visible one row up, so repeating its name on every child is pure
 * duplication -- strip a literal, separator-bounded parent prefix and show
 * only the remainder. Falls back to the full name whenever the child doesn't
 * actually start with the parent's name (nothing to safely strip) or stripping
 * would leave nothing (child name === parent name).
 */
function shortenChildLabel(childName: string, parentName: string): string {
  const child = childName.trim();
  const parent = parentName.trim();
  if (!parent || !child.toLowerCase().startsWith(parent.toLowerCase())) return child;
  const rest = child.slice(parent.length).replace(/^[\s:\-–—/]+/, "");
  return rest.length > 0 ? rest : child;
}

/** Builds one account node (and its channel-slice + child-account descendants) for a single coaId (or unmapped bucket) within a section. `parentLabel` is the immediate parent account's raw (unshortened) name, used to strip a duplicative prefix from this node's own label -- omitted for root accounts, which always show their full name. */
function buildAccountNode(
  key: string,
  rowsByAccount: Map<string, FinancialsRow[]>,
  childKeysByParent: Map<string, string[]>,
  months: string[],
  depth: number,
  parentLabel?: string,
): TreeNode {
  const ownRows = rowsByAccount.get(key)!;
  const first = ownRows[0];
  const label = parentLabel ? shortenChildLabel(first.accountName, parentLabel) : first.accountName;

  const childKeys = childKeysByParent.get(key) ?? [];
  const childAccountNodes = childKeys.map((childKey) =>
    buildAccountNode(childKey, rowsByAccount, childKeysByParent, months, depth + 1, first.accountName),
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
    label,
    children: [...childAccountNodes, ...sliceNodes],
    depth,
    isSection: false,
  };
}

/**
 * Builds a section node from an already-filtered row list: groups rows into
 * a parent/child account tree, and rolls all root accounts up into the
 * section's own `.row` total. Shared by buildSection (rows matching one
 * known statementSection) and buildOtherSection (rows matching none of a
 * statement's known sections).
 */
function buildSectionFromRows(sectionRows: FinancialsRow[], statementSection: string, label: string, months: string[]): TreeNode {
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

/** Builds a top-level section node (Revenue, COGS, Bank & Cash, ...) for the given known statementSection. */
function buildSection(rows: FinancialsRow[], statementSection: string, label: string, months: string[]): TreeNode {
  return buildSectionFromRows(rows.filter((r) => r.statementSection === statementSection), statementSection, label, months);
}

/**
 * M1 fix: mapped rows whose statementSection isn't one of a statement's
 * known sections (see aggregateRows.ts's coaSection fallback -- an
 * unrecognized/missing CoA accountType maps to statementSection "other")
 * were previously dropped entirely by buildSection's exact-match filter --
 * silently vanishing from both the rendered statement and Net Income/its
 * per-statement equivalent. This catch-all renders them under an "Other"
 * section instead, so mapped money is never invisible.
 */
function buildOtherSection(rows: FinancialsRow[], knownSections: ReadonlySet<string>, months: string[]): TreeNode {
  return buildSectionFromRows(rows.filter((r) => !knownSections.has(r.statementSection)), "other", "Other", months);
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

// Known statementSection values per statement kind (M1). Any row whose
// statementSection isn't in the relevant set here falls to buildOtherSection's
// "Other" catch-all instead of being silently dropped. cash_flow reuses the
// same 5 P&L sections it derives cash movement from.
const PL_KNOWN_SECTIONS: ReadonlySet<string> = new Set(["revenue", "other_income", "cogs", "expenses", "other_expense"]);
const BS_KNOWN_SECTIONS: ReadonlySet<string> = new Set([
  "bank", "ar", "other_current_assets", "fixed_assets",
  "ap", "credit_card", "other_current_liabilities", "long_term_liabilities", "equity",
]);

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
  // M1: rows whose statementSection isn't one of the 5 known P&L sections
  // (unrecognized/missing CoA accountType) still render, and still count
  // toward Net Income -- nothing mapped is ever silently invisible.
  const other = buildOtherSection(rows, PL_KNOWN_SECTIONS, months);
  const netIncome = subtotal("Net Income", [revenue, otherIncome, cogs, opEx, otherExp, other], months);

  return [revenue, otherIncome, totalIncome, cogs, grossProfit, opEx, otherExp, other, netIncome];
}

function buildCashFlow(rows: FinancialsRow[], months: string[]): TreeNode[] {
  const revenue = buildSection(rows, "revenue", "Cash Collected — Revenue", months);
  const otherIncome = buildSection(rows, "other_income", "Cash Collected — Other Income", months);
  const totalCashIn = subtotal("Total Cash In", [revenue, otherIncome], months);

  const cogs = buildSection(rows, "cogs", "Cash Paid — Cost of Goods Sold", months);
  const opEx = buildSection(rows, "expenses", "Cash Paid — Operating Expenses", months);
  const otherExp = buildSection(rows, "other_expense", "Cash Paid — Other Expenses", months);
  const totalCashOut = subtotal("Total Cash Out", [cogs, opEx, otherExp], months);

  // M1: same catch-all as buildPl -- rows outside the 5 known sections still
  // render and still count toward the bottom-line Net Operating total. Left
  // out of Total Cash In/Out since an unrecognized section's cash direction
  // (in vs. out) isn't knowable.
  const other = buildOtherSection(rows, PL_KNOWN_SECTIONS, months);
  const netOperating = subtotal("Net Operating", [revenue, otherIncome, cogs, opEx, otherExp, other], months);

  return [revenue, otherIncome, totalCashIn, cogs, opEx, otherExp, totalCashOut, other, netOperating];
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
  // M1: an unrecognized/missing CoA accountType gives no signal for which
  // side of the balance sheet a row belongs on, so the "Other" catch-all is
  // folded into the final Total Liabilities + Equity grand total (rather
  // than guessed into Total Assets) -- it still renders and still counts
  // toward a grand total, so it's never silently dropped.
  const other = buildOtherSection(rows, BS_KNOWN_SECTIONS, months);
  const totalLiabEquity = subtotal(
    "Total Liabilities + Equity",
    [ap, creditCard, otherCurrentLiab, longTermLiab, equity, other],
    months,
  );

  return [
    bank, ar, otherCurrentAssets, totalCurrentAssets, fixedAssets, totalAssets,
    ap, creditCard, otherCurrentLiab, totalCurrentLiab, longTermLiab, totalLiab,
    equity, other, totalLiabEquity,
  ];
}

export function buildTree(rows: FinancialsRow[], statement: StatementKind): TreeNode[] {
  const months = monthsOf(rows);
  if (statement === "balance_sheet") return buildBalanceSheet(rows, months);
  if (statement === "cash_flow") return buildCashFlow(rows, months);
  return buildPl(rows, months);
}

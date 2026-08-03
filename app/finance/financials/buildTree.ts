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

import { CREDIT_SIDE_SECTIONS } from "@/lib/finance/financials/statementTotal";
import { isManualAdjustmentRow } from "@/lib/finance/financials/manualAdjustment";
import type { BblCoverage, FinancialsRow, StatementKind } from "@/lib/finance/financials/types";
import { CHANNEL_LABEL } from "./channelColors";

export interface TreeNode {
  row: FinancialsRow | null;
  label: string;
  children: TreeNode[];
  depth: number;
  isSection: boolean;
  /** Marks an operator-entered exception line broken out from its parent account's own postings (currently only a manual entry -- see lib/finance/financials/manualAdjustment.ts). Like a channel slice it is a DECOMPOSITION of the parent's already-rolled-up total, not an extra addend on top of it; FinancialsTable renders it italic so it reads as an exception building INTO the account rather than as a real sub-account of its own. */
  isAdjustment?: boolean;
}

/** Minimal chart_of_accounts reference shape buildTree needs to nest an account under an ancestor that itself carries no direct postings (see CoaLookup below), to sort siblings by GL number, and to seed a real-but-currently-unused root account as a $0 line (see seedEmptyRootAccounts). `statementSection` is the SAME derived value aggregateRows.ts's coaSection() would assign this account if it ever got a posting -- computed once server-side (buildFinancials.ts) for every CoA account, not just posted-to ones. */
export interface CoaAccountRef {
  id: string;
  parentId: string | null;
  accountName: string;
  accountNumber: string | null;
  statementSection: string;
}

/**
 * Most CoA accounts that exist purely to group their children (e.g. "Taproom
 * Revenue", "Taproom Liquor Sales") never receive a direct posting themselves
 * -- every transaction lands on a deeper leaf account. FinancialsRow[] alone
 * only contains accounts that DO have postings, so nesting purely off rows
 * silently flattens every such grouping account's descendants into false
 * roots. CoaLookup carries the full chart_of_accounts parent_id/name/number/
 * section data (fetched once, independent of which accounts happen to have
 * transactions) so the tree can synthesize a zero-postings node for a
 * grouping account and still nest its real descendants underneath it, order
 * siblings by GL number, and seed a real but currently-unused root account.
 */
type CoaLookup = Map<string, { parentId: string | null; accountName: string; accountNumber: string | null; statementSection: string }>;

function buildCoaLookup(coaAccounts: CoaAccountRef[]): CoaLookup {
  return new Map(
    coaAccounts.map((c) => [
      c.id,
      { parentId: c.parentId, accountName: c.accountName, accountNumber: c.accountNumber, statementSection: c.statementSection },
    ]),
  );
}

/** A node's GL account number as a sortable number, or null when it has none (unmapped bucket, or a synthesized top-line adjustment like Manual Net-Sales Adjustment with no coaId at all). */
function accountNumberOf(node: TreeNode, coaMap: CoaLookup): number | null {
  const coaId = node.row?.coaId ?? null;
  if (!coaId) return null;
  const raw = coaMap.get(coaId)?.accountNumber;
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Orders sibling account nodes by ascending GL account number, mirroring the Chart of Accounts' own numbering ("P&L order should generally follow CoA numbering"). Accounts with no GL number (unmapped, or synthesized entries like Manual Net-Sales Adjustment) sort last, after every numbered account, in their original relative order. */
function sortByAccountNumber(nodes: TreeNode[], coaMap: CoaLookup): TreeNode[] {
  return [...nodes].sort((a, b) => {
    const an = accountNumberOf(a, coaMap);
    const bn = accountNumberOf(b, coaMap);
    if (an === null && bn === null) return 0;
    if (an === null) return 1;
    if (bn === null) return -1;
    return an - bn;
  });
}

// A manual entry (lib/finance/financials/manualNetSales.ts) is posted to a
// REAL account's coaId, so it lands in the same rowsByAccount bucket as that
// account's own Square/invoice postings and silently disappears into its
// total -- see buildAccountNode's breakOutAdjustment.
const MANUAL_ADJUSTMENT_LABEL = "Manual Adjustment";

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
    // Absent over the wire (toWireResponse strips it) but present when this
    // runs server-side or in a test, so roll up whatever is actually there
    // rather than assuming either.
    ids.push(...(r.sourceRef.ids ?? []));
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

/**
 * An account's parent coaId, preferring its own row data (always present when
 * it has postings, and requires no CoaLookup) and falling back to the CoA
 * reference table for a synthesized grouping account that has none.
 *
 * A row's own NULL parentId is not treated as authoritative: rows are
 * synthesized by several injectors (manualNetSales.ts, buildFinancials.ts's
 * AR/balance injection) and one leaving parentId unset must not be able to
 * promote a real, genuinely-nested account to a section root -- consult the
 * full chart_of_accounts reference table before concluding it has no parent.
 * Only a null on BOTH sides means a true root.
 */
function resolveParentId(key: string, rowsByAccount: Map<string, FinancialsRow[]>, coaMap: CoaLookup): string | null {
  const ownRows = rowsByAccount.get(key) ?? [];
  const fromRow = ownRows.find((r) => r.parentId !== null)?.parentId ?? null;
  return fromRow ?? coaMap.get(key)?.parentId ?? null;
}

/** Builds one account node (and its channel-slice + child-account descendants) for a single coaId (or unmapped bucket) within a section. A grouping account with no direct postings of its own (ownRows empty) still gets a node here -- purely so its real descendants have somewhere to nest -- with its own row rolling up to just the sum of its children. `parentLabel` is the immediate parent account's raw (unshortened) name, used to strip a duplicative prefix from this node's own label -- omitted for root accounts, which always show their full name. */
function buildAccountNode(
  key: string,
  rowsByAccount: Map<string, FinancialsRow[]>,
  coaMap: CoaLookup,
  childKeysByParent: Map<string, string[]>,
  months: string[],
  depth: number,
  statementSection: string,
  parentLabel?: string,
): TreeNode {
  const allOwnRows = rowsByAccount.get(key) ?? [];
  const adjustmentRows = allOwnRows.filter(isManualAdjustmentRow);
  const childKeys = childKeysByParent.get(key) ?? [];

  // A manual adjustment posts to a REAL account's coaId, so it arrives in the
  // same bucket as that account's own postings and vanishes into its total.
  // Break it out into its own line whenever the account has anything else to
  // be distinguished from -- sub-accounts, or postings of its own. When it
  // doesn't (the account's entire balance IS the adjustment), the account row
  // already IS that line, so the adjustment stays folded into ownRows and a
  // lone, identical child is never emitted.
  const breakOutAdjustment = adjustmentRows.length > 0 && (childKeys.length > 0 || adjustmentRows.length < allOwnRows.length);
  const ownRows = breakOutAdjustment ? allOwnRows.filter((r) => !isManualAdjustmentRow(r)) : allOwnRows;

  const rawAccountName = ownRows[0]?.accountName ?? coaMap.get(key)?.accountName ?? key;
  const label = parentLabel ? shortenChildLabel(rawAccountName, parentLabel) : rawAccountName;
  const coaId = ownRows[0]?.coaId ?? key;
  const parentId = resolveParentId(key, rowsByAccount, coaMap);

  const childAccountNodes = sortByAccountNumber(
    childKeys.map((childKey) =>
      buildAccountNode(childKey, rowsByAccount, coaMap, childKeysByParent, months, depth + 1, statementSection, rawAccountName),
    ),
    coaMap,
  );

  const distinctChannels = [...new Set(ownRows.map((r) => r.channel))];
  const sliceNodes: TreeNode[] =
    distinctChannels.length > 1
      ? distinctChannels
          .sort()
          .map((channel) => {
            const channelRows = ownRows.filter((r) => r.channel === channel);
            const sliceRow = sumRows(channelRows, months, {
              coaId,
              parentId,
              accountName: rawAccountName,
              statementSection,
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

  // ownRows may be [] for a synthesized grouping account -- sumRows([], ...)
  // correctly yields a zeroed row, so its own contribution to rolledRow is
  // just "nothing", leaving the children's totals as the whole of it.
  const ownTotalRow = sumRows(ownRows, months, {
    coaId,
    parentId,
    accountName: rawAccountName,
    statementSection,
    channel: distinctChannels.length === 1 ? distinctChannels[0] : "unknown",
  });

  const adjustmentNodes: TreeNode[] = breakOutAdjustment
    ? [
        {
          row: sumRows(adjustmentRows, months, {
            coaId,
            parentId,
            accountName: adjustmentRows[0].accountName,
            statementSection,
            channel: adjustmentRows[0].channel,
          }),
          label: MANUAL_ADJUSTMENT_LABEL,
          children: [],
          depth: depth + 1,
          isSection: false,
          isAdjustment: true,
        },
      ]
    : [];

  // Every addend of this account's displayed total, in one place: its own
  // postings, its sub-accounts' already-rolled totals, and any broken-out
  // adjustment. When the adjustment ISN'T broken out it's already inside
  // ownTotalRow instead -- so the account's total is identical either way.
  // Breaking it out is purely a presentation split, never a change in what
  // 4100 sums to.
  const addends = [
    ownTotalRow,
    ...childAccountNodes.map((n) => n.row).filter((r): r is FinancialsRow => r !== null),
    ...adjustmentNodes.map((n) => n.row).filter((r): r is FinancialsRow => r !== null),
  ];

  const rolledRow =
    addends.length > 1
      ? sumRows(addends, months, {
          coaId,
          parentId,
          accountName: rawAccountName,
          statementSection,
          channel: ownTotalRow.channel,
        })
      : ownTotalRow;

  return {
    row: rolledRow,
    label,
    // Adjustment last, after the GL-numbered sub-accounts and channel slices:
    // it reads as the closing exception line that builds into this account.
    children: [...childAccountNodes, ...sliceNodes, ...adjustmentNodes],
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
 *
 * Nesting walks the FULL ancestor chain via `coaMap` (not just accounts that
 * happen to have their own postings) so a leaf whose parent/grandparent
 * account carries no direct transactions still nests under it instead of
 * rendering as a false root -- see CoaLookup's header comment.
 */
function buildSectionFromRows(
  sectionRows: FinancialsRow[],
  statementSection: string,
  label: string,
  months: string[],
  coaMap: CoaLookup,
): TreeNode {
  const rowsByAccount = new Map<string, FinancialsRow[]>();
  for (const row of sectionRows) {
    const key = accountKey(row);
    const bucket = rowsByAccount.get(key);
    if (bucket) bucket.push(row);
    else rowsByAccount.set(key, [row]);
  }

  // Every posted-to account starts "needed"; climb each one's ancestor chain
  // (own row's parentId first, then the CoA reference table for accounts with
  // no rows of their own) adding any ancestor we can actually describe (has a
  // row OR a CoA entry) until we hit one we can't describe, or one already known.
  const neededIds = new Set(rowsByAccount.keys());
  for (const startKey of rowsByAccount.keys()) {
    let current = startKey;
    for (;;) {
      const parentId = resolveParentId(current, rowsByAccount, coaMap);
      if (!parentId || neededIds.has(parentId)) break;
      if (!rowsByAccount.has(parentId) && !coaMap.has(parentId)) break;
      neededIds.add(parentId);
      current = parentId;
    }
  }

  const childKeysByParent = new Map<string, string[]>();
  const rootKeys: string[] = [];
  for (const key of neededIds) {
    const parentKey = resolveParentId(key, rowsByAccount, coaMap);
    if (parentKey !== null && neededIds.has(parentKey)) {
      const bucket = childKeysByParent.get(parentKey);
      if (bucket) bucket.push(key);
      else childKeysByParent.set(parentKey, [key]);
    } else {
      rootKeys.push(key);
    }
  }

  // A real root-level CoA account for this section that's simply never had a
  // posting (e.g. "Interest Earned" under Other Income) would otherwise be
  // entirely invisible -- the section would read as "no mapped transactions"
  // even though the account genuinely exists and is just currently unused.
  // Seed it in as a $0 line instead, same as any other root account (its own
  // real children, if it somehow already has posted ones, are already in
  // neededIds/rootKeys via the ancestor walk above; this only adds ROOTS with
  // literally zero postings anywhere in their own subtree, so it can't ever
  // double up with an account already found above).
  for (const [id, entry] of coaMap) {
    if (entry.statementSection === statementSection && entry.parentId === null && !neededIds.has(id)) {
      rootKeys.push(id);
    }
  }

  // Root accounts always show their own full name (no parentLabel passed).
  // An earlier attempt shortened a root account against the section's own
  // (hardcoded) title, which caused a real regression: an exact-name-match
  // root like "OPERATING EXPENSES" under "Operating Expenses" correctly fell
  // back to its full name (nothing left to strip), but a suffixed one like
  // "COST OF GOODS SOLD (COGS)" got reduced to the bare fragment "(COGS)".
  // The section header and its root account are visually distinguished by
  // styling (SectionBlock is a static divider, never a real account row),
  // not by text truncation, so this doesn't need the shortening treatment.
  const accountNodes = sortByAccountNumber(
    rootKeys.map((key) => buildAccountNode(key, rowsByAccount, coaMap, childKeysByParent, months, 1, statementSection)),
    coaMap,
  );

  return {
    row: sumNodeRows(accountNodes, months, label, statementSection),
    label,
    children: accountNodes,
    depth: 0,
    isSection: true,
  };
}

/** Builds a top-level section node (Revenue, COGS, Bank & Cash, ...) for the given known statementSection. */
function buildSection(rows: FinancialsRow[], statementSection: string, label: string, months: string[], coaMap: CoaLookup): TreeNode {
  return buildSectionFromRows(rows.filter((r) => r.statementSection === statementSection), statementSection, label, months, coaMap);
}

/**
 * M1 fix: mapped rows whose statementSection isn't one of a statement's
 * known sections (see aggregateRows.ts's coaSection fallback -- an
 * unrecognized/missing CoA accountType maps to statementSection "other")
 * were previously dropped entirely by buildSection's exact-match filter --
 * silently vanishing from both the rendered statement and Net Income/its
 * per-statement equivalent. This catch-all renders them under an "Other"
 * section instead, so mapped money is never invisible.
 *
 * Two categories are explicitly EXCLUDED from this catch-all (and so from
 * Net Income/Total Assets), not just left out of the 5/9 known sections:
 *   - `otherStatementSections`: a row genuinely mapped to the OTHER
 *     statement's account (e.g. a capex purchase or customer deposit posted
 *     to a real Balance Sheet account, surfacing inside the P&L). It already
 *     renders correctly under its own real section in that other statement
 *     -- conflating it into THIS statement's Net Income/Total would double
 *     up a real balance-sheet movement as if it were income-statement
 *     activity.
 *   - Genuinely unmapped rows (`coaId === null`): their revenue/expense
 *     nature is unknown, and they're already tracked (once) by the Data
 *     Quality panel -- folding them into Net Income here would silently
 *     count an unclassified dollar amount as if it were a known category,
 *     AND double up the "this needs attention" signal in two places.
 * What's left after both exclusions is the rare case the M1 fix actually
 * targets: a REAL, mapped CoA account whose accountType isn't recognized by
 * ACCOUNT_TYPE_SECTION at all (a code/config gap, not a user miscoding).
 */
function buildOtherSection(
  rows: FinancialsRow[],
  knownSections: ReadonlySet<string>,
  otherStatementSections: ReadonlySet<string>,
  months: string[],
  coaMap: CoaLookup,
): TreeNode {
  return buildSectionFromRows(
    rows.filter((r) => r.coaId !== null && !knownSections.has(r.statementSection) && !otherStatementSections.has(r.statementSection)),
    "other",
    "Other",
    months,
    coaMap,
  );
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
  "bank", "ar", "other_current_assets", "fixed_assets", "other_assets",
  "ap", "credit_card", "other_current_liabilities", "long_term_liabilities", "equity",
]);

function buildPl(rows: FinancialsRow[], months: string[], coaMap: CoaLookup): TreeNode[] {
  const revenue = buildSection(rows, "revenue", "Revenue", months, coaMap);
  const otherIncome = buildSection(rows, "other_income", "Other Income", months, coaMap);
  const totalIncome = subtotal("Total Income", [revenue, otherIncome], months);

  const cogs = buildSection(rows, "cogs", "Cost of Goods Sold", months, coaMap);
  // Gross Profit excludes Other Income by convention -- and must match the
  // grossMarginPct KPI (lib/finance/financials/summaries.ts), which is
  // (revenue - cogs) / revenue with no other_income term. Total Income above
  // still includes other_income; Net Income below still includes everything.
  // See spec §7 (KPI and statement must never disagree) + Task 15 final
  // review, finding I1.
  const grossProfit = subtotal("Gross Profit", [revenue, cogs], months);

  const opEx = buildSection(rows, "expenses", "Operating Expenses", months, coaMap);
  const otherExp = buildSection(rows, "other_expense", "Other Expenses", months, coaMap);
  // M1: rows whose statementSection isn't one of the 5 known P&L sections
  // (unrecognized/missing CoA accountType) still render, and still count
  // toward Net Income -- nothing mapped is ever silently invisible. Rows
  // mapped to a genuine Balance Sheet account, or entirely unmapped, are
  // excluded here (see buildOtherSection's header comment) -- they never
  // belonged in Net Income to begin with.
  const other = buildOtherSection(rows, PL_KNOWN_SECTIONS, BS_KNOWN_SECTIONS, months, coaMap);
  const netIncome = subtotal("Net Income", [revenue, otherIncome, cogs, opEx, otherExp, other], months);

  return [revenue, otherIncome, totalIncome, cogs, grossProfit, opEx, otherExp, other, netIncome];
}

function buildCashFlow(rows: FinancialsRow[], months: string[], coaMap: CoaLookup): TreeNode[] {
  const revenue = buildSection(rows, "revenue", "Cash Collected — Revenue", months, coaMap);
  const otherIncome = buildSection(rows, "other_income", "Cash Collected — Other Income", months, coaMap);
  const totalCashIn = subtotal("Total Cash In", [revenue, otherIncome], months);

  const cogs = buildSection(rows, "cogs", "Cash Paid — Cost of Goods Sold", months, coaMap);
  const opEx = buildSection(rows, "expenses", "Cash Paid — Operating Expenses", months, coaMap);
  const otherExp = buildSection(rows, "other_expense", "Cash Paid — Other Expenses", months, coaMap);
  const totalCashOut = subtotal("Total Cash Out", [cogs, opEx, otherExp], months);

  // M1: same catch-all as buildPl -- rows outside the 5 known sections still
  // render and still count toward the bottom-line Net Operating total. Left
  // out of Total Cash In/Out since an unrecognized section's cash direction
  // (in vs. out) isn't knowable. Same BS/unmapped exclusion as buildPl.
  const other = buildOtherSection(rows, PL_KNOWN_SECTIONS, BS_KNOWN_SECTIONS, months, coaMap);
  const netOperating = subtotal("Net Operating", [revenue, otherIncome, cogs, opEx, otherExp, other], months);

  return [revenue, otherIncome, totalCashIn, cogs, opEx, otherExp, totalCashOut, other, netOperating];
}

// The five credit-side statement sections (spec §4.5): normalizeSign.ts's
// NEGATIVE_SECTIONS stores these as negative internally (assets positive,
// liabilities/equity negative -- "Assets + Liabilities + Equity = 0"). A
// conventionally presented balance sheet shows liabilities and equity
// POSITIVE instead, so this display-only flip negates exactly these five,
// never touching an asset section.
// Shared with the sort accessor (controls.ts) via statementTotal.ts -- two
// copies of this set is how the cell and the sort came to disagree on sign.
const CREDIT_SECTIONS = CREDIT_SIDE_SECTIONS;

function negateRow(row: FinancialsRow): FinancialsRow {
  const amountCentsByMonth: Record<string, number> = {};
  for (const [m, v] of Object.entries(row.amountCentsByMonth)) amountCentsByMonth[m] = -v || 0;
  return { ...row, amountCentsByMonth };
}

/** Negates every row in a subtree (this node's own row, plus every descendant account/child/slice row), unconditionally. */
function negateTreeDeep(node: TreeNode): TreeNode {
  return { ...node, row: node.row ? negateRow(node.row) : null, children: node.children.map(negateTreeDeep) };
}

/** Balance-sheet presentation only: negate the credit-side sections so
 *  liabilities and equity render positive, per standard presentation.
 *  Applied at the tree layer AFTER every sum, so stored snapshots and
 *  normalizeSign.ts keep the internal convention (spec §2.2) and the P&L
 *  is untouched. */
function toPresentationSign(node: TreeNode, section: string): TreeNode {
  return CREDIT_SECTIONS.has(section) ? negateTreeDeep(node) : node;
}

/**
 * Balancing Difference = Total Assets − (Total Liabilities + Equity),
 * computed ONCE, post-flip, off the two already-built subtotal nodes --
 * never re-derived from the pre-flip additive identity (they're the same
 * number; two formulas invite drift). Zero when the books genuinely balance;
 * well-defined (and non-zero) even when an entire side has no data at all.
 */
function balancingDifference(totalAssets: TreeNode, totalLiabEquity: TreeNode, months: string[]): TreeNode {
  const amountCentsByMonth: Record<string, number> = {};
  for (const m of months) {
    amountCentsByMonth[m] = (totalAssets.row?.amountCentsByMonth[m] ?? 0) - (totalLiabEquity.row?.amountCentsByMonth[m] ?? 0);
  }
  return {
    row: {
      coaId: null,
      parentId: null,
      accountName: "Balancing Difference",
      statementSection: "other",
      channel: "unknown",
      posCategory: null,
      kegSize: null,
      amountCentsByMonth,
      bblByMonth: Object.fromEntries(months.map((m) => [m, 0])),
      bblCoverage: "full",
      mappingSource: "rule",
      sourceRef: { table: "", ids: [] },
    },
    label: "Balancing Difference",
    children: [],
    depth: 0,
    isSection: false,
  };
}

function buildBalanceSheet(rows: FinancialsRow[], months: string[], coaMap: CoaLookup): TreeNode[] {
  const bank = buildSection(rows, "bank", "Bank & Cash", months, coaMap);
  const ar = buildSection(rows, "ar", "Accounts Receivable", months, coaMap);
  const otherCurrentAssets = buildSection(rows, "other_current_assets", "Other Current Assets", months, coaMap);
  const totalCurrentAssets = subtotal("Total Current Assets", [bank, ar, otherCurrentAssets], months);
  const fixedAssets = buildSection(rows, "fixed_assets", "Fixed Assets", months, coaMap);
  // Non-current, so deliberately OUTSIDE Total Current Assets above but inside
  // Total Assets — QBO's "Other Assets" type (security deposits, lease buyouts,
  // goodwill).
  const otherAssets = buildSection(rows, "other_assets", "Other Assets", months, coaMap);
  const totalAssets = subtotal("Total Assets", [bank, ar, otherCurrentAssets, fixedAssets, otherAssets], months);

  // Credit-side sections, built in the internal (liabilities/equity negative)
  // convention like everything above, then flipped to conventional
  // presentation (positive) below -- see toPresentationSign's header comment.
  const apInternal = buildSection(rows, "ap", "Accounts Payable", months, coaMap);
  const creditCardInternal = buildSection(rows, "credit_card", "Credit Cards", months, coaMap);
  const otherCurrentLiabInternal = buildSection(rows, "other_current_liabilities", "Other Current Liabilities", months, coaMap);
  const longTermLiabInternal = buildSection(rows, "long_term_liabilities", "Long-Term Liabilities", months, coaMap);
  const equityInternal = buildSection(rows, "equity", "Equity", months, coaMap);
  // M1: an unrecognized/missing CoA accountType gives no signal for which
  // side of the balance sheet a row belongs on, so the "Other" catch-all is
  // folded into the final Total Liabilities + Equity grand total (rather
  // than guessed into Total Assets) -- it still renders and still counts
  // toward a grand total, so it's never silently dropped. Rows mapped to a
  // genuine P&L account, or entirely unmapped, are excluded (symmetric with
  // buildPl) -- a P&L account's balance never belonged on the Balance Sheet.
  const otherInternal = buildOtherSection(rows, BS_KNOWN_SECTIONS, PL_KNOWN_SECTIONS, months, coaMap);

  const ap = toPresentationSign(apInternal, "ap");
  const creditCard = toPresentationSign(creditCardInternal, "credit_card");
  const otherCurrentLiab = toPresentationSign(otherCurrentLiabInternal, "other_current_liabilities");
  const longTermLiab = toPresentationSign(longTermLiabInternal, "long_term_liabilities");
  const equity = toPresentationSign(equityInternal, "equity");
  // "Other" always sits on the credit side of the grand total below (see
  // buildOtherSection's caller-side comment) -- flip it unconditionally
  // rather than through toPresentationSign's section-membership check, since
  // its own row.statementSection is the synthetic "other", not one of the
  // five named credit sections.
  const other = negateTreeDeep(otherInternal);

  const totalCurrentLiab = subtotal("Total Current Liabilities", [ap, creditCard, otherCurrentLiab], months);
  const totalLiab = subtotal("Total Liabilities", [ap, creditCard, otherCurrentLiab, longTermLiab], months);
  const totalLiabEquity = subtotal(
    "Total Liabilities + Equity",
    [ap, creditCard, otherCurrentLiab, longTermLiab, equity, other],
    months,
  );

  const diff = balancingDifference(totalAssets, totalLiabEquity, months);

  return [
    bank, ar, otherCurrentAssets, totalCurrentAssets, fixedAssets, otherAssets, totalAssets,
    ap, creditCard, otherCurrentLiab, totalCurrentLiab, longTermLiab, totalLiab,
    equity, other, totalLiabEquity, diff,
  ];
}

export function buildTree(rows: FinancialsRow[], statement: StatementKind, coaAccounts: CoaAccountRef[] = []): TreeNode[] {
  const months = monthsOf(rows);
  const coaMap = buildCoaLookup(coaAccounts);
  if (statement === "balance_sheet") return buildBalanceSheet(rows, months, coaMap);
  if (statement === "cash_flow") return buildCashFlow(rows, months, coaMap);
  return buildPl(rows, months, coaMap);
}

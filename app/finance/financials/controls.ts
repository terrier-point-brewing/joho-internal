// Search/filter/sort config for the consolidated Financials page (Task 11),
// wired through the shared lib/table engine (docs/UI_STANDARD.md's
// search/filter/sort standard). Also hosts the pure helpers the page's
// flat-engine -> hierarchical-statement adaptation needs (spec §8):
// qualityBucket (the "quality" filter's predicate) and retainAncestors
// (keeps a matched child account's parent chain present so buildTree.ts
// never has to render an orphaned/dangling child).
//
// No DB/Square/React imports -- pure over already-fetched FinancialsRow[].

import type { ControlsConfig } from "@/lib/table/types";
import type { Channel, FinancialsRow } from "@/lib/finance/financials/types";
import type { StatementSection } from "@/lib/finance/accountSections";
import { isUncategorized, isUnknownVolume } from "@/lib/finance/financials/summaries";
import { CHANNEL_LABEL } from "./channelColors";

export type QualityBucket = "unmapped" | "uncategorized" | "unknownVolume" | "ok";

/**
 * Data-quality bucket for a single row, priority-ordered: unmapped (no CoA
 * mapping) beats uncategorized (missing channel on a channel-bearing row)
 * beats unknownVolume beats ok. "uncategorized" defers to
 * lib/finance/financials/summaries.ts's isUncategorized -- channel is only
 * a meaningful dimension for revenue/other-income rows, so expense/bank/
 * refund rows (which aggregateRows.ts hardcodes to channel: "unknown")
 * never get flagged just for lacking a channel. "unknownVolume" defers to
 * that same file's isUnknownVolume -- any beer row (draft, keg, or can)
 * whose BBL coverage isn't "full", full stop; draft pours resolve a real
 * BBL from the sold variation's fl-oz the same as kegs/cans, so ordinary
 * draft revenue no longer needs a special exclusion here.
 * Deliberately does NOT inspect `mappingSource` -- invoice provenance is
 * unreliable (documented limitation, see spec).
 */
export function qualityBucket(r: FinancialsRow): QualityBucket {
  if (r.coaId === null) return "unmapped";
  if (isUncategorized(r)) return "uncategorized";
  if (isUnknownVolume(r)) return "unknownVolume";
  return "ok";
}

// "ok" is a valid qualityBucket() return value (used by the matches
// predicate) but isn't offered as a filter chip -- the quality filter exists
// to isolate problem rows, not to isolate clean ones.
export const QUALITY_OPTIONS: { value: QualityBucket; label: string }[] = [
  { value: "unmapped", label: "Unmapped" },
  { value: "uncategorized", label: "Uncategorized" },
  { value: "unknownVolume", label: "Unknown Volume" },
];

// Channel is "unknown" for uncategorized rows too, but that's still a
// legitimate filterable value (isolate exactly those rows) -- every Channel
// key gets an option, in channelColors.ts's declared (insertion) order.
export const CHANNEL_OPTIONS = (Object.keys(CHANNEL_LABEL) as Channel[]).map((value) => ({
  value,
  label: CHANNEL_LABEL[value],
}));

// Human-readable labels for every StatementSection, mirroring buildTree.ts's
// PL/Balance-Sheet section titles so the "Section" filter reads the same as
// the table's own section headers.
export const SECTION_LABEL: Record<StatementSection, string> = {
  revenue: "Revenue",
  cogs: "Cost of Goods Sold",
  expenses: "Operating Expenses",
  other_income: "Other Income",
  other_expense: "Other Expenses",
  bank: "Bank & Cash",
  ar: "Accounts Receivable",
  other_current_assets: "Other Current Assets",
  fixed_assets: "Fixed Assets",
  other_assets: "Other Assets",
  ap: "Accounts Payable",
  credit_card: "Credit Cards",
  other_current_liabilities: "Other Current Liabilities",
  long_term_liabilities: "Long-Term Liabilities",
  equity: "Equity",
};

/**
 * Builds the ControlsConfig for a given month set. Sort columns are dynamic
 * (Total + one per month key) because the month range depends on the
 * selected year/statement -- callers (FinancialsPage) rebuild this via
 * useMemo keyed on `months`, matching ExportInvoicesTab.tsx's dynamic-config
 * precedent for a config that closes over fetched data. `default: null` --
 * no active sort leaves buildTree's canonical section/account order
 * untouched (the statement's canonical presentation order).
 */
export function buildFinancialsControls(months: string[]): ControlsConfig<FinancialsRow> {
  return {
    search: [{ param: "q", accessor: (r) => r.accountName }],
    filters: [
      { param: "channel", accessor: (r) => r.channel, multi: true },
      { param: "section", accessor: (r) => r.statementSection },
      { param: "quality", matches: (r, sel) => sel.includes(qualityBucket(r)) },
    ],
    sort: {
      columns: [
        { key: "total", accessor: (r) => months.reduce((s, m) => s + (r.amountCentsByMonth[m] ?? 0), 0) },
        ...months.map((m) => ({ key: m, accessor: (r: FinancialsRow) => r.amountCentsByMonth[m] ?? 0 })),
      ],
      default: null,
    },
  };
}

/**
 * Given the flat rows that survived search/filter/sort (`survivors`) and the
 * full unfiltered row set (`allRows`), adds back every ancestor account row
 * (walking parentId -> coaId chains, breadth-first) so buildTree.ts's
 * parent/child COA nesting (buildSection's rowsByAccount/childKeysByParent)
 * never has to render a matched child account with a missing parent --
 * a well-formed tree, no orphaned/dangling children.
 *
 * Order-stable for the part that matters: survivors keep their (possibly
 * sorted) relative order at the front of the output. buildTree groups
 * accounts by first-seen position in the row array it's given (Map
 * insertion order), so this ordering is what makes a `toggleSort` on
 * <SortableTh> reorder leaves within their section -- a pulled-back-in
 * ancestor that didn't itself survive is appended after all survivors, so
 * at most its own top-level position (not its matched descendants') is
 * affected.
 */
export function retainAncestors(survivors: FinancialsRow[], allRows: FinancialsRow[]): FinancialsRow[] {
  const byCoaId = new Map<string, FinancialsRow[]>();
  for (const row of allRows) {
    if (row.coaId === null) continue;
    const bucket = byCoaId.get(row.coaId);
    if (bucket) bucket.push(row);
    else byCoaId.set(row.coaId, [row]);
  }

  const out = [...survivors];
  const seen = new Set<FinancialsRow>(survivors);

  let frontier = survivors;
  while (frontier.length > 0) {
    const next: FinancialsRow[] = [];
    for (const row of frontier) {
      if (!row.parentId) continue;
      for (const parentRow of byCoaId.get(row.parentId) ?? []) {
        if (seen.has(parentRow)) continue;
        seen.add(parentRow);
        out.push(parentRow);
        next.push(parentRow);
      }
    }
    frontier = next;
  }

  return out;
}

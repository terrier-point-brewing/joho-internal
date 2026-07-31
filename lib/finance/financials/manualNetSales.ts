// Ports manual_net_sales_entries proration (the deleted app/api/finance/
// sales/taproom/route.ts's day-weighted overlap adjustment, see git show
// 51fff28^:app/api/finance/sales/taproom/route.ts and its sibling dollar-total
// version at lib/finance/pl.ts's proratedManualRevenue) onto the consolidated
// FinancialsRow model (Square parity fix B). Pure function over already-fetched
// entries -- no DB/Square imports -- called from buildFinancials.ts after
// aggregateRows, same shape as buildFinancials.ts's injectOpenInvoiceAr.

import type { Channel, FinancialsRow } from "./types";
import { coaSection, type CoaRecord } from "./aggregateRows";
import { MANUAL_ADJUSTMENT_TABLE } from "./manualAdjustment";

/** manual_entries row filtered to entry_kind = 'flow' (start_date/end_date/amount_cents/chart_of_accounts_id; id kept for sourceRef traceability). */
export interface ManualNetSalesEntryRecord {
  id: string;
  /** manual_entries.start_date, "YYYY-MM-DD" (non-null for entry_kind = 'flow'). */
  startDate: string;
  /** manual_entries.end_date, "YYYY-MM-DD" (non-null for entry_kind = 'flow'). */
  endDate: string;
  amountCents: number;
  /** manual_entries.chart_of_accounts_id -- NOT NULL at the DB level. */
  chartOfAccountsId: string;
}

const MS_PER_DAY = 86_400_000;

/**
 * Manual entries carry NO sales channel.
 *
 * This was hardcoded "taproom" back when the feature was the taproom-only
 * manual_net_sales_entries table edited under Taproom > Targets. PR #300
 * replaced it with brewery-wide Manual Entries under Finance > Transactions,
 * where the operator picks any GL account -- so an entry coded to, say, 4200
 * Wholesale / Distribution Revenue was still being stamped (and chipped in
 * the P&L) as Taproom. A manual entry has no channel dimension at all, which
 * is exactly what "unknown" means for the expense/bank/refund rows
 * aggregateRows.ts already stamps that way.
 *
 * summaries.ts's isUncategorized excludes these rows explicitly -- "revenue
 * row with no channel" is a real miscoding signal for a POS/invoice row, but
 * never for a manual entry, which HAS no channel to be missing.
 */
const MANUAL_CHANNEL: Channel = "unknown";

function parseDateUtc(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** Inclusive [monthStart, monthEnd] bounds for a "YYYY-MM" key, both UTC midnight. */
function monthBounds(month: string): { start: Date; end: Date } {
  const [y, m] = month.split("-").map(Number);
  return {
    start: new Date(Date.UTC(y, m - 1, 1)),
    end: new Date(Date.UTC(y, m, 0)), // day 0 of next month = last day of this month
  };
}

/**
 * Day-weighted proration of `entries` onto a single `month`, mirroring the
 * deleted route's overlap formula exactly:
 *   oStart = max(monthStart, entryStart); oEnd = min(monthEnd, entryEnd)
 *   if oStart <= oEnd: cents += round(amount_cents * overlapDays / entryDays)
 * where entryDays/overlapDays are inclusive day counts. Returns the ids of
 * every entry that overlaps the month (even if its own rounded contribution
 * happens to be 0), for sourceRef traceability.
 */
export function proratedManualAdjustment(
  entries: ManualNetSalesEntryRecord[],
  month: string,
): { cents: number; ids: string[] } {
  const { start: monthStart, end: monthEnd } = monthBounds(month);
  let cents = 0;
  const ids: string[] = [];

  for (const entry of entries) {
    const entryStart = parseDateUtc(entry.startDate);
    const entryEnd = parseDateUtc(entry.endDate);
    const oStart = monthStart > entryStart ? monthStart : entryStart;
    const oEnd = monthEnd < entryEnd ? monthEnd : entryEnd;
    if (oStart <= oEnd) {
      const entryDays = Math.round((entryEnd.getTime() - entryStart.getTime()) / MS_PER_DAY) + 1;
      const overlapDays = Math.round((oEnd.getTime() - oStart.getTime()) / MS_PER_DAY) + 1;
      cents += Math.round((entry.amountCents * overlapDays) / entryDays);
      ids.push(entry.id);
    }
  }

  return { cents, ids };
}

/**
 * Synthesizes ONE taproom-revenue FinancialsRow PER DISTINCT
 * chart_of_accounts_id spanning `months` (mirrors buildFinancials.ts's
 * injectOpenInvoiceAr shape), zero-filled per month like aggregateRows' own
 * groups so downstream month-key derivation (e.g.
 * app/finance/financials/buildTree.ts reading rows[0]'s keys) stays correct
 * regardless of row order.
 *
 * Entries are grouped by chartOfAccountsId BEFORE proration -- two
 * overlapping flow entries coded to different accounts (e.g. one Revenue,
 * one Other Income) must never collapse into a single blended total filed
 * under just one of their accounts. Each group gets its own prorated
 * amountCentsByMonth (via proratedManualAdjustment, unchanged), its own
 * coaId, its own coaSection()-derived statementSection, and its own
 * sourceRef.ids containing only that group's entry ids.
 *
 * `coa` is the full chart-of-accounts reference list (buildFinancials.ts's
 * src.coa), used both to resolve each group's statementSection and to
 * resolve accountName to the real account name (see the accountName comment
 * below) -- required, not optional: an omitted/empty coa silently resolves
 * every row to aggregateRows.ts's UNMAPPED_SECTION via coaSection(undefined)
 * instead of failing loudly.
 *
 * accountName is the real resolved account's name (matching how every other
 * CoA-mapped row is labelled -- see aggregateRows.ts), suffixed with
 * "(Manual Adjustment)" so the row stays identifiable as a manual, not
 * Square-sourced, posting without misrepresenting which account it belongs
 * to (mappingSource: "manual" and sourceRef.table: "manual_entries" already
 * carry that signal too).
 *
 * Appends nothing (returns `rows` unchanged) when every group prorates to 0
 * across every month -- no entries configured, or none overlap the window.
 */
export function injectManualNetSales(
  rows: FinancialsRow[],
  entries: ManualNetSalesEntryRecord[],
  months: string[],
  coa: CoaRecord[],
): FinancialsRow[] {
  const coaMap = new Map(coa.map((c) => [c.id, c]));

  const entriesByAccount = new Map<string, ManualNetSalesEntryRecord[]>();
  for (const entry of entries) {
    const bucket = entriesByAccount.get(entry.chartOfAccountsId);
    if (bucket) bucket.push(entry);
    else entriesByAccount.set(entry.chartOfAccountsId, [entry]);
  }

  const synthesized: FinancialsRow[] = [];

  for (const [coaId, groupEntries] of entriesByAccount) {
    const amountCentsByMonth: Record<string, number> = {};
    const idSet = new Set<string>();
    let hasNonZero = false;

    for (const month of months) {
      const { cents, ids } = proratedManualAdjustment(groupEntries, month);
      amountCentsByMonth[month] = cents;
      if (cents !== 0) hasNonZero = true;
      for (const id of ids) idSet.add(id);
    }

    if (!hasNonZero) continue;

    const account = coaMap.get(coaId);
    const accountName = account ? `${account.accountName} (Manual Adjustment)` : "Manual Net-Sales Adjustment";

    synthesized.push({
      coaId,
      // The REAL account's parent, not null. A hardcoded null here made the
      // adjustment's account look parentless to buildTree, which resolves an
      // account's parent from its own rows first (resolveParentId) -- so a
      // grouping account whose ONLY row is its manual adjustment (e.g. 4100
      // Taproom Revenue, every real posting landing on a 41x0 leaf) was
      // promoted to a section root and rendered as a sibling of its own
      // parent 4000 BREWERY REVENUE instead of nesting under it.
      parentId: account?.parentId ?? null,
      accountName,
      statementSection: coaSection(account),
      channel: MANUAL_CHANNEL,
      posCategory: null,
      kegSize: null,
      amountCentsByMonth,
      bblByMonth: {},
      bblCoverage: "full",
      mappingSource: "manual",
      sourceRef: { table: MANUAL_ADJUSTMENT_TABLE, ids: [...idSet] },
    });
  }

  if (synthesized.length === 0) return rows;

  return [...rows, ...synthesized];
}

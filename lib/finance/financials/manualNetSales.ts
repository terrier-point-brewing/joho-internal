// Ports manual_net_sales_entries proration (the deleted app/api/finance/
// sales/taproom/route.ts's day-weighted overlap adjustment, see git show
// 51fff28^:app/api/finance/sales/taproom/route.ts and its sibling dollar-total
// version at lib/finance/pl.ts's proratedManualRevenue) onto the consolidated
// FinancialsRow model (Square parity fix B). Pure function over already-fetched
// entries -- no DB/Square imports -- called from buildFinancials.ts after
// aggregateRows, same shape as buildFinancials.ts's injectOpenInvoiceAr.

import type { Channel, FinancialsRow } from "./types";

/** manual_net_sales_entries row (start_date/end_date/amount_cents; id kept for sourceRef traceability). */
export interface ManualNetSalesEntryRecord {
  id: string;
  /** manual_net_sales_entries.start_date, "YYYY-MM-DD". */
  startDate: string;
  /** manual_net_sales_entries.end_date, "YYYY-MM-DD". */
  endDate: string;
  amountCents: number;
}

const MS_PER_DAY = 86_400_000;
const MANUAL_CHANNEL: Channel = "taproom";
const MANUAL_TABLE = "manual_net_sales_entries";

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
 * Synthesizes ONE taproom-revenue FinancialsRow spanning `months` (mirrors
 * buildFinancials.ts's injectOpenInvoiceAr shape), zero-filled per month like
 * aggregateRows' own groups so downstream month-key derivation (e.g.
 * app/finance/financials/buildTree.ts reading rows[0]'s keys) stays correct
 * regardless of row order. coaId is deliberately null (a top-line adjustment,
 * not a CoA-mapped account) -- see summaries.ts's buildDataQuality, which
 * excludes sourceRef.table === "manual_net_sales_entries" from the unmapped
 * bucket so this doesn't read as a mapping oversight.
 *
 * Appends nothing (returns `rows` unchanged) when every month prorates to 0
 * -- no entries configured, or none overlap the window.
 */
export function injectManualNetSales(
  rows: FinancialsRow[],
  entries: ManualNetSalesEntryRecord[],
  months: string[],
): FinancialsRow[] {
  const amountCentsByMonth: Record<string, number> = {};
  const idSet = new Set<string>();
  let hasNonZero = false;

  for (const month of months) {
    const { cents, ids } = proratedManualAdjustment(entries, month);
    amountCentsByMonth[month] = cents;
    if (cents !== 0) hasNonZero = true;
    for (const id of ids) idSet.add(id);
  }

  if (!hasNonZero) return rows;

  const synthesized: FinancialsRow = {
    coaId: null,
    parentId: null,
    accountName: "Manual Net-Sales Adjustment",
    statementSection: "revenue",
    channel: MANUAL_CHANNEL,
    posCategory: null,
    kegSize: null,
    amountCentsByMonth,
    bblByMonth: {},
    bblCoverage: "full",
    mappingSource: "manual",
    sourceRef: { table: MANUAL_TABLE, ids: [...idSet] },
  };

  return [...rows, synthesized];
}

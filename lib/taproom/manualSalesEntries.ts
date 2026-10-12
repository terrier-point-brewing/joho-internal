// Which manual_entries belong in TAPROOM net sales (Taproom > Targets >
// Achievement, via /api/net-sales-summary), and how much of each lands in a
// date window.
//
// History: the Achievement tab used to read a taproom-only table
// (manual_net_sales_entries). PR #300 folded that table into the brewery-wide
// manual_entries, where an operator codes an entry to ANY GL account. The
// route kept summing every flow entry, so a payroll correction on 6110 or a
// duplicate-bill reversal on 5110 was being added to (or subtracted from)
// taproom sales. Oct 1–4 2026 showed $4,528.82 against $2,011.98 of real
// Square sales because nine GL corrections dated Oct 1 netted to +$2,516.84.
//
// Rule: only entries coded to a taproom revenue account count.
//   4000  BREWERY REVENUE — where the pre-#300 taproom adjustments (Arryved /
//         CBC transition) were migrated to; they are taproom sales.
//   41xx  Taproom Revenue and every leaf under it.
//   4910  Taproom Discounts (contra-revenue, so it is already signed).
// Wholesale (42xx), contract brewing (43xx), billable (4400), every COGS /
// expense / liability account: never taproom sales.

export interface TaproomManualEntry {
  startDate: string;   // YYYY-MM-DD, inclusive
  endDate: string;     // YYYY-MM-DD, inclusive
  amountCents: number;
  accountNumber: string | null;
}

export function isTaproomSalesAccount(accountNumber: string | null | undefined): boolean {
  if (!accountNumber) return false;
  return accountNumber === "4000" || accountNumber.startsWith("41") || accountNumber === "4910";
}

const MS_PER_DAY = 86_400_000;

function parseDateUtc(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/**
 * Day-weighted overlap of each taproom-sales entry with [start, end], same
 * formula lib/finance/financials/manualNetSales.ts uses for the P&L. Entries
 * on non-taproom accounts contribute nothing.
 */
export function proratedTaproomManualSalesCents(
  entries: TaproomManualEntry[],
  start: string,
  end: string,
): number {
  const windowStart = parseDateUtc(start);
  const windowEnd = parseDateUtc(end);
  let cents = 0;
  for (const entry of entries) {
    if (!isTaproomSalesAccount(entry.accountNumber)) continue;
    const entryStart = parseDateUtc(entry.startDate);
    const entryEnd = parseDateUtc(entry.endDate);
    const oStart = windowStart > entryStart ? windowStart : entryStart;
    const oEnd = windowEnd < entryEnd ? windowEnd : entryEnd;
    if (oStart > oEnd) continue;
    const entryDays = Math.round((entryEnd.getTime() - entryStart.getTime()) / MS_PER_DAY) + 1;
    const overlapDays = Math.round((oEnd.getTime() - oStart.getTime()) / MS_PER_DAY) + 1;
    cents += Math.round((entry.amountCents * overlapDays) / entryDays);
  }
  return cents;
}

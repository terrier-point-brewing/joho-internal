// GL 3300 (Retained Earnings) -- cumulative P&L net income from inception
// through periodEnd. Deliberately ONE number for 3300 only: no
// current-year-earnings split, because the chart of accounts has no such
// account.
//
// Reuses fetchPos/fetchInvoiceLines/fetchExpenses/fetchBank/fetchRefunds/
// fetchCoa (lib/finance/financials/fetchSources.ts) and aggregateRows/
// buildKpis (the exact P&L aggregation pipeline), then sums that pipeline's
// OWN per-month net income across every month up to periodEnd, so there is no
// second net-income formula that could drift from the statement's.
//
// ── One known gap, stated rather than implied ────────────────────────────────
// This is the P&L pipeline, but it is not the whole P&L STATEMENT. The
// statement injects manual net sales entries (buildFinancials.ts's
// injectManualNetSales) AFTER aggregateRows; this provider never fetched them
// and still does not. Measured at 2026-08-31 that is the entire remaining
// difference: the statement's months sum to 2,858,336 and this returns 620,236,
// the 2,238,100 gap being April's 1,346,800 and May's 891,300 of manual net
// sales, to the cent. Verified month by month -- June, July and August agree
// exactly, because only April and May carry manual entries.
//
// Left alone deliberately. It predates this file, it is a question about which
// revenue belongs in equity rather than a defect in the arithmetic here, and
// folding it in would move GL 3300 again. Do not describe this provider as
// reconciling to the P&L statement until it is settled.
//
// ── Why it is not read off the previous month's snapshot ─────────────────────
// Retained earnings at period end looks like "last month's 3300 plus this
// month's net income", which would replace a from-inception scan with one
// lookup. It is not safe here, on two counts, both measured against the live
// database rather than reasoned about:
//
//   1. A stored snapshot goes stale. gl_account_balances is written once, when
//      the month is snapshotted, and the P&L data underneath it keeps moving --
//      a GL remap, a backfilled sync, a corrected invoice line. June 2026's
//      stored 3300 was -618,028 while recomputing the same month from inception
//      gave -620,694. Chaining onto that propagates the drift forward instead
//      of healing it, and nothing in the resulting figure says so.
//
//   2. Net income is not additive across a split range, because payroll is not.
//      An expense matched to a pay period is prorated across the pay period's
//      OWN months (aggregateRows' prorateAcrossMonths), so an expense dated
//      3 July with a 22 June - 5 July period lands partly in June. Fetches
//      filter on accounting_date, so a June-only fetch never sees it. Summing
//      per-month pieces and summing the whole range are different numbers.
//
// The from-inception recompute is therefore load-bearing, not incidental, and
// the cost is paid down by fetching POS pages concurrently (fetchPos's
// pageConcurrency) rather than by not fetching them.
//
// ── Why every month is passed to aggregateRows, not one canonical month ──────
// This used to collapse every record's date onto periodEnd's month and ask for
// that single month, so the per-month bucketing would sum the whole range into
// one figure. That silently dropped money. aggregateRows re-derives the month
// for a payroll-matched expense from its PAY PERIOD, not from the accounting
// date the collapse rewrote, and then keeps only the months it was asked for --
// so every payroll allocation outside the canonical month was discarded. At
// periodEnd 2026-08-31 that was all of it: 3,945,851 cents of payroll expense
// missing, equity overstated by the same, and the claim above that this cannot
// disagree with the P&L untrue.
//
// Asking for the real months instead costs nothing and needs no collapse: every
// record lands in its own month, every month is summed, and a payroll period
// straddling periodEnd correctly leaves its later slice out.

import {
  fetchCoa,
  fetchPos,
  fetchInvoiceLines,
  fetchExpenses,
  fetchBank,
  fetchRefunds,
} from "@/lib/finance/financials/fetchSources";
import type { DateRange } from "@/lib/finance/financials/fetchSources";
import { aggregateRows } from "@/lib/finance/financials/aggregateRows";
import { buildKpis } from "@/lib/finance/financials/summaries";
import { cumulativeDepreciationThrough } from "@/lib/finance/financials/derivedStatementRows";
import { fetchDepreciationState } from "@/lib/finance/depreciation/state";
import { cumulativeInventoryReliefThrough } from "@/lib/finance/inventoryRelief";
import { PAGE_CONCURRENCY } from "@/lib/supabase/paginate";
import { registerProvider } from "../registry";
import type { BalanceContext, BalanceProvider } from "../registry";

/** From-inception range through periodEnd (inclusive) -- mirrors fetchSources.ts's own cumulativeRange, but for an arbitrary month-end rather than only "now" or a calendar year-end. */
function cumulativeRangeThrough(periodEnd: string): DateRange {
  const nextDay = new Date(`${periodEnd}T00:00:00.000Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  return { startDateStr: null, start: null, endDateStr: periodEnd, end: nextDay.toISOString() };
}

/** aggregateRows' own month key: the first 7 characters, for a plain date or an ISO timestamp alike. */
function monthKeyOf(dateStr: string | null | undefined): string | null {
  return dateStr && dateStr.length >= 7 ? dateStr.slice(0, 7) : null;
}

/**
 * Every "YYYY-MM" from the earliest month anything could land in through
 * periodEnd's month, ascending.
 *
 * The lower bound is read off the records themselves rather than configured, so
 * there is no inception date to keep in step with the data. Pay-period STARTS
 * are included in that scan: a payroll expense is attributed to its pay
 * period's months, which can begin before the month its accounting date falls
 * in, and a month missing from this list is a month aggregateRows drops.
 *
 * The upper bound is periodEnd's month and stops there deliberately -- a pay
 * period straddling period end has a slice belonging to the month AFTER, which
 * is not retained earnings yet.
 */
export function monthsThroughPeriodEnd(dates: (string | null | undefined)[], periodEnd: string): string[] {
  const endMonth = periodEnd.slice(0, 7);

  let startMonth = endMonth;
  for (const candidate of dates) {
    const month = monthKeyOf(candidate);
    if (month && month < startMonth) startMonth = month;
  }

  const months: string[] = [];
  let [year, month] = startMonth.split("-").map(Number);
  for (let cursor = startMonth; cursor <= endMonth; ) {
    months.push(cursor);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
    cursor = `${year}-${String(month).padStart(2, "0")}`;
  }
  return months;
}

export const retainedEarnings: BalanceProvider = {
  key: "retainedEarnings",
  label: "Retained earnings",
  kind: "derived",
  appliesTo: (coa) => coa.accountNumber === "3300",
  async compute(ctx: BalanceContext): Promise<number | null> {
    const { supabase, periodEnd } = ctx;
    const range = cumulativeRangeThrough(periodEnd);

    const [coa, pos, invoiceLines, expenses, bank, refunds] = await Promise.all([
      fetchCoa(supabase),
      // The one source that runs past a single 1000-row page from inception,
      // and the only reason this provider was ever slow.
      fetchPos(supabase, range, { pageConcurrency: PAGE_CONCURRENCY }),
      fetchInvoiceLines(supabase, range, false),
      fetchExpenses(supabase, range, false),
      fetchBank(supabase, range, "pl"),
      fetchRefunds(supabase, range),
    ]);

    const months = monthsThroughPeriodEnd(
      [
        ...pos.map((r) => r.transactionDate),
        ...invoiceLines.map((r) => r.invoiceDate),
        ...expenses.map((r) => r.accountingDate),
        ...expenses.map((r) => r.payrollPeriod?.start),
        ...bank.map((r) => r.transactionDate),
        ...refunds.map((r) => r.refundedAt),
      ],
      periodEnd,
    );

    const rows = aggregateRows({
      pos,
      invoiceLines,
      expenses,
      bank,
      refunds,
      // No P&L analog for the balance-sheet-only tip/tax accrual records --
      // never included here.
      tipAccruals: [],
      taxAccruals: [],
      coa,
      months,
    });

    // buildKpis' netIncomeCents is a plain per-month sum of the P&L sections
    // (summaries.ts's sumSectionByMonth), so adding its months up is the P&L's
    // own net income over the whole range -- no second formula to drift from.
    const netIncomeByMonth = buildKpis(rows, months).netIncomeCents;
    let netIncomeCents = months.reduce((total, month) => total + (netIncomeByMonth[month] ?? 0), 0);

    // The P&L statement's two DERIVED rows (buildFinancials.ts, statement
    // "pl"): depreciation and inventory relief. They come from the same shared
    // modules the statement injects from, so equity absorbs to the cent what
    // those rows recognize -- leaving them out would widen the balancing
    // difference by every month's depreciation and the whole inventory value,
    // which is the exact shape of the manual-net-sales gap documented above.
    // (That gap itself remains untouched, for that comment's own reasons.)
    const throughMonth = periodEnd.slice(0, 7);
    const now = new Date();
    const liveMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const [depreciationStates, inventoryCents] = await Promise.all([
      fetchDepreciationState(supabase, coa),
      cumulativeInventoryReliefThrough(supabase, throughMonth, liveMonth),
    ]);
    netIncomeCents += cumulativeDepreciationThrough(depreciationStates, throughMonth);
    netIncomeCents += inventoryCents;

    // Equity is credit-normal; the internal convention stores liabilities
    // and equity NEGATIVE (normalizeSign.ts's NEGATIVE_SECTIONS), so a
    // profit (positive netIncomeCents) INCREASES equity, which reads as MORE
    // negative here. Guard -0 so a genuinely-zero period returns 0, not -0
    // (Object.is(-0, 0) is false, and a period with no P&L activity is
    // supposed to read as an honest zero, not fail a strict equality check).
    return netIncomeCents === 0 ? 0 : -netIncomeCents;
  },
};

registerProvider(retainedEarnings);

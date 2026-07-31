// GL 3300 (Retained Earnings) -- cumulative P&L net income from inception
// through periodEnd. Deliberately ONE number for 3300 only: no
// current-year-earnings split, because the chart of accounts has no such
// account.
//
// Reuses fetchPos/fetchInvoiceLines/fetchExpenses/fetchBank/fetchRefunds/
// fetchCoa (lib/finance/financials/fetchSources.ts) and aggregateRows/
// buildKpis (the exact P&L aggregation pipeline) over a purpose-built
// cumulative-through-periodEnd range, so this provider can never compute a
// net-income formula that disagrees with the P&L statement.

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
import { registerProvider } from "../registry";
import type { BalanceContext, BalanceProvider } from "../registry";

/** From-inception range through periodEnd (inclusive) -- mirrors fetchSources.ts's own cumulativeRange, but for an arbitrary month-end rather than only "now" or a calendar year-end. */
function cumulativeRangeThrough(periodEnd: string): DateRange {
  const nextDay = new Date(`${periodEnd}T00:00:00.000Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  return { startDateStr: null, start: null, endDateStr: periodEnd, end: nextDay.toISOString() };
}

/** Collapses every record's date field onto `canonical`, mirroring fetchSources.ts's own (private) collapseDates -- needed so aggregateRows' per-month bucketing sums the WHOLE inception-to-periodEnd range into one figure instead of dropping rows outside a single month. */
function collapseDates<T, K extends keyof T>(records: T[], field: K, canonical: T[K]): T[] {
  return records.map((r) => ({ ...r, [field]: canonical }));
}

export const retainedEarnings: BalanceProvider = {
  key: "retainedEarnings",
  label: "Retained earnings",
  kind: "derived",
  appliesTo: (coa) => coa.accountNumber === "3300",
  async compute(ctx: BalanceContext): Promise<number | null> {
    const { supabase, periodEnd } = ctx;
    const range = cumulativeRangeThrough(periodEnd);
    const canonicalMonth = periodEnd.slice(0, 7);

    const [coa, pos, invoiceLines, expenses, bank, refunds] = await Promise.all([
      fetchCoa(supabase),
      fetchPos(supabase, range),
      fetchInvoiceLines(supabase, range, false),
      fetchExpenses(supabase, range, false),
      fetchBank(supabase, range, "pl"),
      fetchRefunds(supabase, range),
    ]);

    const rows = aggregateRows({
      pos: collapseDates(pos, "transactionDate", canonicalMonth),
      invoiceLines: collapseDates(invoiceLines, "invoiceDate", canonicalMonth),
      expenses: collapseDates(expenses, "accountingDate", canonicalMonth),
      bank: collapseDates(bank, "transactionDate", canonicalMonth),
      refunds: collapseDates(refunds, "refundedAt", canonicalMonth),
      // No P&L analog for the balance-sheet-only tip/tax accrual records --
      // never included here.
      tipAccruals: [],
      taxAccruals: [],
      coa,
      months: [canonicalMonth],
    });

    const netIncomeCents = buildKpis(rows, [canonicalMonth]).netIncomeCents[canonicalMonth] ?? 0;

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

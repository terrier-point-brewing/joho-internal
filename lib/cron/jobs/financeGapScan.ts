/**
 * Finds days where persisted orders disagree with Square, and re-syncs only
 * those.
 *
 * The nightly finance-sync covers a trailing week. Anything that falls out of
 * that window is stranded permanently — May 2026's refunds sat missing for two
 * and a half months for exactly this reason. Widening the nightly window would
 * fix it by brute force, but it would also push every invoice-backed order in
 * that window through the non-canonical invoice-line rebuild flagged in
 * lib/finance/syncPosTransactions.ts, nightly.
 *
 * So this compares per-day COUNTS across a long lookback and re-syncs only the
 * days that actually differ — normally none, in which case it writes a
 * cron_runs row and does nothing else. That is also what makes it the safest
 * job on the list to run by hand: on a healthy set of books it changes nothing.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchCompletedOrders, fetchCanceledOrders } from "@/lib/square/orders";
import { syncPosTransactionsForRange } from "@/lib/finance/syncPosTransactions";
import { syncRefundsForRange } from "@/lib/finance/syncRefunds";
import { countSquareOrdersByDay, countDbOrdersByDay, diffDailyCounts } from "@/lib/finance/gapScan";
import { eachDateString, addDaysStr, todayLocalDate, dayStartUtc, dayEndUtc } from "@/lib/utils/datetime";

/** How far back to compare. Long enough to catch a gap the nightly window lost. */
const LOOKBACK_DAYS = 120;

/**
 * Ceiling on days re-synced per run. A genuinely broken month should not turn
 * one invocation into a 90-day rebuild; the remainder is reported and picked up
 * on the next run. Never silently truncate — `gapsUnhealed` says what was left
 * behind, and is the signal that pressing "Run now" again will do more work.
 */
const MAX_RESYNC_DAYS = 14;

export async function runFinanceGapScan(supabase: SupabaseClient) {
  const endDate = todayLocalDate();
  const startDate = addDaysStr(endDate, -LOOKBACK_DAYS);
  const days = eachDateString(startDate, endDate);

  // Same universe the sync itself persists: COMPLETED + CANCELED. Return
  // orders are filtered inside countSquareOrdersByDay.
  const [completed, canceled] = await Promise.all([
    fetchCompletedOrders(startDate, endDate),
    fetchCanceledOrders(startDate, endDate),
  ]);
  const squareByDay = countSquareOrdersByDay([...completed, ...canceled]);

  const { data: dbRows, error } = await supabase
    .from("square_orders")
    .select("transaction_date")
    .gte("transaction_date", dayStartUtc(startDate))
    .lte("transaction_date", dayEndUtc(endDate));
  if (error) throw new Error(`square_orders count query failed: ${error.message}`);

  const dbByDay = countDbOrdersByDay(dbRows ?? []);
  const { missing, surplus } = diffDailyCounts(squareByDay, dbByDay, days);

  const toHeal = missing.slice(0, MAX_RESYNC_DAYS);
  const healed: { date: string; synced: number; refunds: number }[] = [];
  const errors: string[] = [];

  for (const gap of toHeal) {
    try {
      // One day at a time: a gap is usually a single stranded day, and this
      // keeps the invoice-line rebuild scoped to that day's orders.
      const orders = await syncPosTransactionsForRange(supabase, gap.date, gap.date);
      const refunds = await syncRefundsForRange(supabase, gap.date, gap.date);
      healed.push({ date: gap.date, synced: orders.synced, refunds: refunds.synced });
      if (orders.errors?.length) errors.push(`${gap.date}: ${orders.errors.join("; ")}`);
    } catch (e) {
      errors.push(`${gap.date}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    lookbackDays: LOOKBACK_DAYS,
    range: { startDate, endDate },
    daysCompared: days.length,
    gapsFound: missing.length,
    gapsHealed: healed.length,
    // Non-zero means MAX_RESYNC_DAYS capped this run — the rest wait for the
    // next one, scheduled or not.
    gapsUnhealed: Math.max(0, missing.length - toHeal.length),
    healed,
    // Re-sync cannot remove rows, so these need a human. Orders deleted in
    // Square, or leftovers the sync no longer produces, land here.
    surplusDays: surplus,
    errors: errors.length ? errors : undefined,
  };
}

/**
 * Find days where persisted `square_orders` disagrees with Square itself.
 *
 * The nightly finance-sync only re-syncs a trailing week, so a day that fails
 * to land — a webhook delivery lost, a sync that predates a feature, an outage
 * — stays stranded forever once it falls out of that window. That is exactly
 * how May 2026's refunds went missing for two and a half months: refund sync
 * did not exist when May was backfilled, and nothing ever reached back.
 *
 * Widening the nightly window would fix it by brute force, at the cost of
 * re-pulling and rewriting months of orders every night. So instead this
 * compares cheap per-day COUNTS and re-syncs only the days that actually
 * disagree — usually none.
 *
 * Pure: the caller supplies the already-fetched orders and rows.
 */
import { classifyOrderForSync } from "@/lib/finance/syncPosTransactions";
import { localDateString, BREWERY_TZ } from "@/lib/utils/datetime";
import type { Order } from "@/types/square";

/**
 * The local day a synced order lands on. MUST mirror `buildOrderPayload`'s
 * `transaction_date` (closed_at ?? updated_at ?? created_at) — bucketing the
 * two sides on different fields would manufacture gaps on every boundary day.
 */
export function orderTransactionDate(order: Order, tz: string = BREWERY_TZ): string | null {
  const iso = order.closed_at ?? order.updated_at ?? order.created_at;
  return iso ? localDateString(iso, tz) : null;
}

/**
 * Square-side counts per local day — of the orders the sync actually persists.
 *
 * `classifyOrderForSync` is the authority on that, and this asks it rather than
 * restating its rules. Anything it skips (return orders, empty shell orders)
 * must not be counted here: it would show a permanent phantom shortfall on
 * every day that had a refund or a cash-drawer open, and this scan would
 * re-sync those days forever without ever converging.
 */
export function countSquareOrdersByDay(orders: Order[], tz: string = BREWERY_TZ): Map<string, number> {
  const counts = new Map<string, number>();
  for (const order of orders) {
    if (classifyOrderForSync(order) === "skip") continue;
    const day = orderTransactionDate(order, tz);
    if (!day) continue;
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  return counts;
}

/** DB-side counts per local day, from `square_orders.transaction_date`. */
export function countDbOrdersByDay(
  rows: { transaction_date: string | null }[],
  tz: string = BREWERY_TZ,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!row.transaction_date) continue;
    const day = localDateString(row.transaction_date, tz);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  return counts;
}

export interface DayDiff {
  date: string;
  square: number;
  db: number;
}

export interface GapScanDiff {
  /** Square has orders we never persisted — re-syncing the day fixes these. */
  missing: DayDiff[];
  /**
   * We hold MORE orders than Square reports. Re-syncing cannot fix this (the
   * sync never deletes), so these are surfaced for a human instead of being
   * re-synced — otherwise every run would churn the same days forever.
   */
  surplus: DayDiff[];
}

/**
 * Compare the two sides across `days`. Days absent from both maps contribute
 * nothing, so a closed Monday is not a gap.
 */
export function diffDailyCounts(
  squareByDay: Map<string, number>,
  dbByDay: Map<string, number>,
  days: string[],
): GapScanDiff {
  const missing: DayDiff[] = [];
  const surplus: DayDiff[] = [];
  for (const date of days) {
    const square = squareByDay.get(date) ?? 0;
    const db = dbByDay.get(date) ?? 0;
    if (square > db) missing.push({ date, square, db });
    else if (db > square) surplus.push({ date, square, db });
  }
  return { missing, surplus };
}

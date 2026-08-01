/**
 * Which month the balance sheet is currently working on.
 *
 * One definition, shared, because two callers must agree on it: the daily cron
 * that snapshots a period, and the connect-time integration check that proves a
 * connection can read that same period. If those drift, the check validates a
 * month the cron is not reading and reports a healthy connection for the wrong
 * reason -- the exact failure a validation exists to prevent.
 *
 * They HAD drifted. The cron resolved "today" in the brewery's timezone while
 * the check used UTC, so between 8pm and midnight Eastern on the last day of a
 * month the two named different periods.
 */
import { addDaysStr } from "@/lib/utils/datetime";

/**
 * Last day (YYYY-MM-DD) of the month before `todayIso`'s month.
 *
 * The current month is never snapshotted: it is still in progress, so a
 * month-end balance for it does not exist yet and asking an integration for one
 * would fail on every healthy connection. Pass a date already resolved in the
 * brewery's timezone (`todayLocalDate()`) -- taking `Date` directly is what let
 * a UTC/local split open up in the first place.
 */
export function mostRecentlyEndedMonthEnd(todayIso: string): string {
  const firstOfThisMonth = `${todayIso.slice(0, 7)}-01`;
  return addDaysStr(firstOfThisMonth, -1);
}

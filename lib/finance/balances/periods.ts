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

/**
 * Is this period end still in the future — the OPEN month?
 *
 * The balance sheet asks providers for two different things through the same
 * argument, and telling them apart is a correctness rule every integration
 * shares:
 *
 *   CLOSED (`periodEnd <= today`) — a month that has actually ended. Answer
 *   with the balance dated exactly on it or with nothing. This figure gets
 *   frozen into the close, and a nearby day's balance labelled as the closing
 *   balance is plausible, undetectable and wrong.
 *
 *   OPEN (`periodEnd > today`) — buildBalanceSheetFinancials live-computes the
 *   current month on every page view by asking for that month's LAST day, so on
 *   12 August it asks for 31 August. No such balance exists yet. Answer with the
 *   running balance as at today; nothing month-end-labelled is being claimed.
 *
 * Demanding an exact row for an open period is not merely strict, it is wrong:
 * it makes the account read as unsourced from the 1st of the month until the
 * close. Both the Ramp and Plaid feeds shipped with that bug.
 *
 * The boundary is deliberately inclusive of today. A period end falling ON
 * today is a month that has arrived, so it is answered exactly.
 */
export function isOpenPeriod(periodEnd: string, todayIso: string): boolean {
  return periodEnd > todayIso;
}

/**
 * How stale a reading may be and still count as "where this account stands
 * now". Feeds lag over weekends and holidays, so the latest available day is
 * the honest answer -- but a capture from three weeks ago presented as the
 * current balance is exactly the plausible-but-wrong figure this codebase
 * refuses elsewhere. Past this, an account reads as unsourced instead.
 */
export const RUNNING_BALANCE_MAX_AGE_DAYS = 7;

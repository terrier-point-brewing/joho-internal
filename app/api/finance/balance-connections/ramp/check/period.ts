/**
 * Which period the connect-time check reads.
 *
 * Its own module rather than an export from route.ts: Next.js expects a route
 * file to export HTTP handlers and segment config, and pure date logic is not
 * something an HTTP handler should have to own to be testable.
 */

/**
 * Last day of the month BEFORE the one containing `today`. UTC throughout — a
 * local-timezone Date would shift the day either side of midnight.
 *
 * The most recently completed month is the right period to check because it is
 * the first one the snapshot would write and the one whose data must therefore
 * exist. Checking the CURRENT month would fail for every healthy connection:
 * mid-month there is no month-end row for Ramp to return.
 */
export function lastCompletedMonthEnd(today: Date): string {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

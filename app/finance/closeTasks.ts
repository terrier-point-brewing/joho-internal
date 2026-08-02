// Shapes returned by GET /api/finance/balance-close, shared by the nudge banner
// and the month-end close panel it links to.
//
// Both surfaces render the SAME task list, one as a count and one as a piece of
// work, so they must agree on what a task is. They previously did not: the
// banner declared its own two-field task type inline and the panel did not
// exist, which is exactly the arrangement where the banner comes to say "2
// accounts need a balance" and the screen it points at shows nothing.

/** A month-end balance somebody still owes, as the close surfaces see it. */
export interface CloseTaskDetail {
  id: string;
  coaId: string;
  periodEnd: string;
  /** This ACCOUNT's deadline, which may differ from the period's. */
  dueDate: string;
  status: "open" | "completed" | "skipped";
  alertSentAt: string | null;
  /** Why this account has no balance this month. Only ever set on a skip. */
  notes: string | null;
  accountName: string;
  accountNumber: string | null;
  /** Null when nobody has been named for this account in Settings. */
  responsibleEmail: string | null;
  /** The balance recorded for THIS period, once one exists. */
  enteredCents: number | null;
  /** The last balance recorded before this period, to sanity-check against. */
  previousBalance: { asOfDate: string; cents: number } | null;
}

export interface CloseTasksResponse {
  periodEnd: string;
  tasks: CloseTaskDetail[];
  closed: boolean;
  /** The period's own deadline, from the business-wide close setting. */
  dueDate: string;
}

/**
 * The month the close workflow is currently chasing.
 *
 * The PRIOR month end, not the current one: the cron only ever creates tasks
 * for the most recently ENDED month (app/api/cron/balance-close/route.ts), so
 * asking about the current month end matched nothing on every possible date --
 * which is how the nudge banner came to be unable to render at all.
 *
 * Computed in UTC to match `monthEnd` and the rest of this codebase's date
 * helpers; a local-time version drifts by a day for negative-offset zones.
 */
export function priorMonthEnd(now: Date = new Date()): string {
  // Day 0 of this month is the last day of the previous one.
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).toISOString().slice(0, 10);
}

/** The last `count` month ends, newest first — the periods a close can be reviewed for. */
export function recentMonthEnds(count: number, now: Date = new Date()): string[] {
  return Array.from({ length: count }, (_, i) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 0)).toISOString().slice(0, 10),
  );
}

/** "2026-07-31" -> "July 2026". Month ends are shown as the month they close. */
export function formatPeriodLabel(periodEnd: string): string {
  const [y, m] = periodEnd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

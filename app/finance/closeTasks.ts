// Shapes returned by GET /api/finance/balance-close, shared by the nudge banner
// and the Period Close surfaces it links to.
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
  /** The feed's own derived figure for this period, when the snapshot holds one — prefilled so confirming is one save. */
  computedCents: number | null;
  /** When that figure was computed, for the "as of" caption. */
  computedAt: string | null;
}

/** Who called this month final (or took it back), and when. */
export interface PeriodCloseState {
  periodEnd: string;
  closed: boolean;
  action: "closed" | "reopened";
  at: string;
  actorId: string | null;
  actorEmail: string | null;
  reason: string | null;
}

/** What closing this month would be asserting about its accounts. */
export interface PeriodCoverage {
  configured: number;
  withBalance: number;
  /** Accounts that carried a balance in an earlier month and produced none in this one. */
  missing: string[];
  /** Configured accounts that have never carried a balance. Counted, not a warning. */
  neverUsed: number;
  /** The period's Balancing Difference from its stored snapshot; null when never snapshotted. */
  balancingDifferenceCents: number | null;
}

export interface CloseTasksResponse {
  periodEnd: string;
  tasks: CloseTaskDetail[];
  /**
   * Null when nobody has ever closed or reopened this month. Not the same as a
   * finished checklist — see `readyToClose`. The two were previously one field
   * called `closed`, which is precisely the conflation between "the work is
   * done" and "the books are final" that the close workflow exists to undo.
   */
  close: PeriodCloseState | null;
  /** Nothing left on the checklist or the duplicate review, and nobody has closed it yet. */
  readyToClose: boolean;
  /** Possible duplicates dated in this month or earlier still waiting for an answer. Always 0 once closed. */
  unreviewedDuplicates: number;
  coverage: PeriodCoverage;
  /** The most recent recalculation of this month, whoever ran it. Null when none is on record. */
  recalculation: LastRecalculation | null;
  /** The month before's balancing difference, when it has one. */
  previousClose: { periodEnd: string; balancingDifferenceCents: number } | null;
  /** The period's own deadline, from the business-wide close setting. */
  dueDate: string;
}

/** One recalculation of a month: the nightly job's, a check run from the page, or a close attempt's. */
export interface LastRecalculation {
  at: string;
  trigger: "schedule" | "manual";
  /** One plain sentence per account that failed. Empty when clean. */
  errors: string[];
  /** The same failures as the provider reported them. */
  rawErrors: string[];
  /** The balancing difference that run arrived at. Null when it could not say. */
  balancingDifferenceCents: number | null;
}

// ── The close, as steps ──────────────────────────────────────────────────────
// The page used to state its three blockers in three different shapes — a
// subtitle, a banner and a row — and the third (a failing recalculation) not
// at all until Close was pressed. These derive one answer per step so the page,
// its summary line, the periods index and the Close button cannot disagree
// about what is left.

export type CloseStepStatus = "done" | "todo" | "attention" | "review";

export interface RecalculationCheck {
  /** `unknown` — nothing on record. Not clean; the close will find out when it reruns. */
  state: "clean" | "failing" | "unknown";
  errors: string[];
  at: string | null;
  trigger: "schedule" | "manual" | null;
}

/**
 * Where the recalculation stands, read off the MOST RECENT one on record.
 *
 * That may be last night's job, a "Check again" from the page, or a close
 * attempt: all three are recorded (lib/finance/balances/recalculationLog.ts),
 * so a check that came back clean a minute ago outranks a failure from 4am and
 * is still what the page says after a reload.
 */
export function recalculationCheck(last: LastRecalculation | null | undefined): RecalculationCheck {
  if (!last) return { state: "unknown", errors: [], at: null, trigger: null };
  return { state: last.errors.length > 0 ? "failing" : "clean", errors: last.errors, at: last.at, trigger: last.trigger };
}

/**
 * Every reason the Close button is not available, as short sentences naming
 * the step. Empty means it can be pressed.
 *
 * An `unknown` recalculation does not block: the close reruns it regardless.
 */
export function closeBlockersLeft(input: { openTasks: number; duplicates: number; recalculation: RecalculationCheck["state"] }): string[] {
  const left: string[] = [];
  if (input.openTasks > 0) {
    left.push(`Step 1: ${input.openTasks} account${input.openTasks === 1 ? "" : "s"} still need${input.openTasks === 1 ? "s" : ""} a balance.`);
  }
  if (input.duplicates > 0) {
    left.push(`Step 2: ${input.duplicates} possible duplicate${input.duplicates === 1 ? "" : "s"} to review.`);
  }
  if (input.recalculation === "failing") {
    left.push("Step 3: the last recalculation failed. Press Check again.");
  }
  return left;
}

/** The same list, straight from a period's response. Empty for a closed month. */
export function closeBlockersFor(data: CloseTasksResponse): string[] {
  if (data.close?.closed) return [];
  return closeBlockersLeft({
    openTasks: data.tasks.filter((t) => t.status === "open").length,
    duplicates: data.unreviewedDuplicates,
    recalculation: recalculationCheck(data.recalculation).state,
  });
}

/**
 * The balancing difference to show for a month, and where it came from.
 *
 * A closed month shows what it was closed at. An open month shows the most
 * recent recalculation's figure when there is one, because a check run from the
 * page is a dry run: it computes the figure without storing it, and the stored
 * one would otherwise go on showing last night's.
 */
export function balancingDifferenceFor(data: CloseTasksResponse): { cents: number | null; basis: "closed" | "recalculated" | "stored" } {
  if (data.close?.closed) return { cents: data.coverage.balancingDifferenceCents, basis: "closed" };
  const recalculated = data.recalculation?.balancingDifferenceCents ?? null;
  if (recalculated !== null) return { cents: recalculated, basis: "recalculated" };
  return { cents: data.coverage.balancingDifferenceCents, basis: "stored" };
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

// "2026-07-31" -> "July 2026". Defined in lib/ because the close route writes
// its refusal sentences server-side and names the month in them; re-exported
// here so the two close surfaces keep importing it from one place.
export { formatPeriodLabel } from "@/lib/finance/balances/periods";

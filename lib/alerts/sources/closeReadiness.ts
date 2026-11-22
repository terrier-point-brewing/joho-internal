/**
 * The pure half of the month-end close alert: which months are waiting on a
 * person, and whether the nightly recalculation can be trusted.
 *
 * ── Why the alert needed more than "missing balances" ────────────────────────
 * October 2026 sat open for three weeks while the morning email said one thing
 * every day: "1040 needs its October balance". That was true and it was a third
 * of the answer. Two possible duplicates also blocked the close, and the gift
 * card step was timing out on 8 nights in 22 -- and the close refuses on both
 * (see describeCloseBlockers in periodClose.ts). The only way to learn that was
 * to press Close and read the refusal, or to ask someone to go and look.
 *
 * So the alert now lists everything the Close button would refuse on, which is
 * the same three things, read from the same places.
 *
 * ── Why every open month, not just the latest ────────────────────────────────
 * The alert used to look only at the most recently ended month. A month still
 * open on the 1st of the following month simply stopped being mentioned -- at
 * exactly the point it had been waiting longest. A close is a human act with no
 * deadline enforced (periodClose.ts), so "late" is the normal case, and the
 * alert has to keep saying it.
 */
import { monthEnd } from "@/lib/finance/manualEntries";
import { mostRecentlyEndedMonthEnd } from "@/lib/finance/balances/periods";
import { addDaysStr } from "@/lib/utils/datetime";

export interface CloseEvent {
  period_end: string;
  action: "closed" | "reopened";
  created_at: string;
}

/**
 * A backlog longer than this is not a to-do list. Twelve months of "enter a
 * balance" lines would bury the one that matters; the oldest are dropped
 * because the newest is where the nightly recalculation is still running.
 */
export const MAX_OPEN_PERIODS = 12;

/**
 * Every ended month that nobody has closed, oldest first.
 *
 * That is each month after the latest closed one, up to the month that most
 * recently ended, plus any earlier month somebody deliberately reopened.
 *
 * With no close on record at all, only the most recently ended month: there is
 * no first month to count from, and walking back to the brewery's first
 * transaction would raise alerts for months that predate the books.
 */
export function unclosedPeriodEnds(events: CloseEvent[], today: string): string[] {
  const latestEnded = mostRecentlyEndedMonthEnd(today);

  // A period's state is its most recent event.
  const latest = new Map<string, CloseEvent>();
  for (const e of events) {
    const seen = latest.get(e.period_end);
    if (!seen || e.created_at > seen.created_at) latest.set(e.period_end, e);
  }

  let lastClosed: string | null = null;
  const open = new Set<string>();
  for (const [periodEnd, e] of latest) {
    if (periodEnd > latestEnded) continue;
    if (e.action === "closed") {
      if (lastClosed === null || periodEnd > lastClosed) lastClosed = periodEnd;
    } else {
      open.add(periodEnd);
    }
  }

  if (lastClosed === null) {
    open.add(latestEnded);
  } else {
    for (let p = monthEnd(addDaysStr(lastClosed, 1)); p <= latestEnded; p = monthEnd(addDaysStr(p, 1))) {
      open.add(p);
    }
  }

  return Array.from(open).sort().slice(-MAX_OPEN_PERIODS);
}

/** One nightly balance-close run for a period, newest first when listed. */
export interface RecalculationRun {
  /** The run's snapshot errors, or the job's own error when it threw. */
  errors: string[];
}

export interface RecalculationTrouble {
  failed: number;
  of: number;
  /** The most recent error text, for the detail line. */
  latestError: string;
}

/**
 * Whether the nightly recalculation is failing often enough to say so.
 *
 * A close reruns the recalculation and refuses if it does not finish cleanly,
 * so a step that fails on some nights is a Close button that refuses on some
 * presses. One bad night out of seven is weather and is not reported; the most
 * recent night failing, or two in the window, is.
 *
 * `runs` is newest first.
 */
export function recalculationTrouble(runs: RecalculationRun[]): RecalculationTrouble | null {
  if (runs.length === 0) return null;
  const failing = runs.filter((r) => r.errors.length > 0);
  if (failing.length === 0) return null;
  if (runs[0].errors.length === 0 && failing.length < 2) return null;
  return { failed: failing.length, of: runs.length, latestError: failing[0].errors[0] };
}

/**
 * Hands each unreviewed duplicate to the first open month it blocks.
 *
 * A close counts every unanswered pair dated in its month OR EARLIER
 * (countUnreviewedDuplicates), so with two months open the same pair blocks
 * both. Listing it under both would read as two jobs; it is one, and doing it
 * clears both.
 */
export function duplicatesByBlockedPeriod(duplicatePeriodEnds: string[], openPeriodEnds: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  const sorted = [...openPeriodEnds].sort();
  for (const d of duplicatePeriodEnds) {
    const blocked = sorted.find((p) => p >= d);
    if (blocked) counts.set(blocked, (counts.get(blocked) ?? 0) + 1);
  }
  return counts;
}

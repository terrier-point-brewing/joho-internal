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
// The definition of "open" moved to lib/finance/balances/openPeriods.ts once
// the nightly job, the periods index and the Financials banner needed it too.
export { unclosedPeriodEnds, MAX_OPEN_PERIODS, type CloseEvent } from "@/lib/finance/balances/openPeriods";

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
 * Whether the month's recalculation is failing right now.
 *
 * Decided by the MOST RECENT run alone, the same rule the close page uses, so
 * the email and the page cannot disagree. The first version also reported two
 * failures anywhere in the last seven, which meant that after a fix (and a
 * clean check proving it) the alert went on saying "failing" for days. A
 * recalculation that fails again will be the most recent run again, and will
 * be reported again.
 *
 * How many of the recent runs failed is carried for the wording only: "3 of
 * the last 7 tries" tells the reader it is not a one-off.
 *
 * `runs` is newest first.
 */
export function recalculationTrouble(runs: RecalculationRun[]): RecalculationTrouble | null {
  if (runs.length === 0 || runs[0].errors.length === 0) return null;
  const failing = runs.filter((r) => r.errors.length > 0);
  return { failed: failing.length, of: runs.length, latestError: runs[0].errors[0] };
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

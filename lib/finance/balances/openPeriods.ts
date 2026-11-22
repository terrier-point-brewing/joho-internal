/**
 * Which ended months nobody has closed.
 *
 * ── Why this is a shared definition ──────────────────────────────────────────
 * A close is a human act with no deadline enforced (periodClose.ts), so a month
 * sitting open for weeks is the normal case, not the exception. Everything that
 * helps a close along has to keep working on a month that is no longer the
 * latest one, and each of them used to pick its own month:
 *
 *   - the nightly job recalculated only the most recently ended month, so on
 *     1 December an unclosed October stopped being refreshed;
 *   - the periods index listed the last six months, so an older open month
 *     would have scrolled off it;
 *   - the Financials banner asked only about the prior month.
 *
 * They now all ask this. The alert source was the first to (it is where the
 * function was written); it re-exports from here.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { monthEnd } from "@/lib/finance/manualEntries";
import { addDaysStr } from "@/lib/utils/datetime";
import { mostRecentlyEndedMonthEnd } from "./periods";

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

/** The same, read from the close record. `today` is the brewery's calendar day. */
export async function listOpenPeriodEnds(supabase: SupabaseClient, today: string): Promise<string[]> {
  const { data, error } = await supabase.from("balance_period_closes").select("period_end, action, created_at");
  if (error) throw new Error(error.message);
  return unclosedPeriodEnds((data ?? []) as CloseEvent[], today);
}

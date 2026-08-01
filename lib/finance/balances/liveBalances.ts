/**
 * Where every account stands RIGHT NOW, for the month that has not closed yet.
 *
 * ── Why this is its own module ───────────────────────────────────────────────
 * It was a private function inside buildBalanceSheetFinancials.ts, which meant
 * the balance sheet showed a live figure for the open month while the Settings
 * screen -- reading gl_account_balances -- showed the last completed month's
 * snapshot. Same account, same label ("Current Balance"), two different
 * numbers, and nothing on either screen saying which was which. Extracting it
 * makes one answer available to both.
 *
 * ── It computes, it does not write ───────────────────────────────────────────
 * Deliberately. gl_account_balances rows are dated to a month END, and the
 * open month has not reached one: persisting a part-way figure under
 * 2026-08-31 would put a mid-month number where every reader expects a closing
 * balance. That is the plausible-but-wrong shape this codebase refuses
 * everywhere else -- see readDailyBalance's exact-date rule for the same
 * decision made about bank feeds.
 *
 * So: the open month is computed on demand and never stored; a month that has
 * ENDED is snapshotted and stored by snapshotPeriod. Recomputing on demand is
 * what the Recompute action does, and it can only target a month that has
 * ended.
 *
 * ── One implementation, shared with the snapshot ─────────────────────────────
 * expandSources and resolveSnapshotWrites are the snapshot's own. These two
 * paths produce the number a user reads on screen and the number that gets
 * frozen into the close, and any drift between them is invisible until a month
 * rolls over and the figure silently changes.
 */
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { monthEnd } from "@/lib/finance/manualEntries";
import { expandSources, fetchDeclaredSources, resolveSnapshotWrites } from "./snapshot";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

export interface LiveBalance {
  balanceCents: number;
  contributions: Record<string, number>;
}

/**
 * The month end an open-month computation is asked for: the last day of the
 * month `todayIso` falls in.
 *
 * Providers key off this being in the FUTURE to answer with a running balance
 * rather than demanding an exact month-end reading -- see periods.ts's
 * isOpenPeriod. Passing anything else here silently turns the live view back
 * into a closed-month query, which reads as unsourced all month.
 */
export function openPeriodEnd(todayIso: string): string {
  return monthEnd(`${todayIso.slice(0, 7)}-01`);
}

/**
 * Live-computes every active source for `periodEnd` without writing anything.
 *
 * A failed account is dropped entirely instead of contributing a partial sum: a
 * missing row reads as unsourced, which is visibly wrong rather than plausibly
 * wrong. Errors are returned rather than thrown so a caller can surface them --
 * the Settings screen shows them against the account, which is the only place
 * a broken integration was previously visible at all.
 */
export async function computeLiveBalances(
  supabase: AdminClient,
  periodEnd: string,
): Promise<{ balances: Map<string, LiveBalance>; errors: string[]; failedAccounts: Set<string> }> {
  const declared = await fetchDeclaredSources(supabase);
  const { sources, results, failedAccounts, errors } = await expandSources(supabase, periodEnd, declared);

  const writes = resolveSnapshotWrites(
    sources,
    results,
    new Map(), // nothing frozen for a live, unwritten compute
  ).filter((w) => !failedAccounts.has(w.coaId));

  const balances = new Map<string, LiveBalance>();
  for (const w of writes) balances.set(w.coaId, { balanceCents: w.balanceCents, contributions: w.contributions });
  return { balances, errors, failedAccounts };
}

/** Convenience wrapper: the open month, resolved from a date already in the brewery's timezone. */
export async function computeOpenMonthBalances(supabase: AdminClient, todayIso: string) {
  return computeLiveBalances(supabase, openPeriodEnd(todayIso));
}

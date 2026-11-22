/**
 * Refreshes the most recently ENDED month (i.e. the month before the one the
 * run date falls in -- the current month is still in progress and shouldn't be
 * snapshotted yet), then every OLDER month nobody has closed (steps 1-3 only;
 * see refreshOlderOpenMonth). In order:
 *
 *   1. ensureTasksForPeriod  -- create a close task for every active account
 *      whose method needs a hand-entered figure and is still missing one for
 *      the period.
 *   2. snapshotPeriod        -- recompute every non-frozen gl_account_balances
 *      row for the period from the registered providers.
 *   3. reconcileCloseTasks   -- close any task whose manual_entries balance
 *      row has since appeared, and reopen any whose balance has since been
 *      deleted (the manual-entries route also calls this immediately on
 *      write; this catches anything changed directly in the DB or between
 *      runs).
 *   3b. recordSquareDrift    -- for any Square-derived account now closed,
 *      log what the derivation predicted against what the operator actually
 *      found. Re-anchoring silently absorbs its own errors; this is the only
 *      record that it did.
 *
 * It sends no email. Accounts still missing a balance are listed on the Home
 * alert center and in the morning alert digest every day until entered.
 * ── What this job deliberately does NOT do ───────────────────────────────────
 * It does not freeze anything. It used to, once every task was done OR the due
 * date had passed, and that second condition turned "the deadline went by" into
 * "these books are final" -- a claim no unattended job is in a position to
 * make. June 2026 was frozen that way with 6 of 45 accounts carrying a balance.
 *
 * Freezing is now the close action in lib/finance/balances/periodClose.ts,
 * performed by a person whose name goes on it. What this run contributes is the
 * evidence they close on: fresh figures and a current checklist. It reports `readyToClose` so a period that is finished but
 * unclosed is visible rather than silently rolling on.
 *
 * runCronJob wraps the whole thing so a run lands in cron_runs for the
 * Settings > Cron Jobs monitor, success or failure.
 *
 * Nothing it does is irreversible -- since the freeze moved out, a manual run
 * is a refresh.
 */
import "@/lib/finance/balances/methods";
import type { SupabaseClient } from "@supabase/supabase-js";
import { snapshotPeriod } from "@/lib/finance/balances/snapshot";
import {
  ensureTasksForPeriod,
  listTasksForPeriod,
  reconcileCloseTasks,
  everyTaskAnswered,
  dueDateForPeriod,
  readCloseConfig,
} from "@/lib/finance/balances/closeTasks";
import { readPeriodClose } from "@/lib/finance/balances/periodClose";
import { recordSquareDrift, squareBalanceAccountIds } from "@/lib/finance/balances/squareDrift";
import { todayLocalDate } from "@/lib/utils/datetime";
// Shared with the integration connect-time check, which must validate the SAME
// period this job reads. It previously had its own copy resolved in UTC.
import { mostRecentlyEndedMonthEnd } from "@/lib/finance/balances/periods";
import { listOpenPeriodEnds } from "@/lib/finance/balances/openPeriods";
import { recordRecalculation } from "@/lib/finance/balances/recalculationLog";

/**
 * How many OLDER open months one run also refreshes. Each is a full
 * recalculation with live reads against Ramp, Plaid and Square (about 20s), so
 * a long backlog is worked newest-first across nights rather than all at once.
 */
const MAX_OLDER_MONTHS_PER_RUN = 3;

/**
 * Refresh a month that ended before the latest one and is still open.
 *
 * The job used to look only at the most recently ended month, so on 1 December
 * an unclosed October stopped being recalculated and its checklist stopped
 * being reconciled -- at exactly the point it had been waiting longest. A close
 * has no deadline, so a month sitting open past the next month end is ordinary
 * and has to keep getting the same care.
 *
 * Isolated per month: one that throws is recorded as failed and the run goes
 * on, because the latest month's result has already been computed and must not
 * be lost to an older month's problem.
 */
async function refreshOlderOpenMonth(supabase: SupabaseClient, periodEnd: string) {
  const startedAt = new Date();
  try {
    const tasksCreated = await ensureTasksForPeriod(supabase, periodEnd);
    const snapshot = await snapshotPeriod(supabase, periodEnd);
    const reconciled = await reconcileCloseTasks(supabase, periodEnd);
    await recordRecalculation(supabase, {
      periodEnd,
      errors: snapshot.errors,
      balancingDifferenceCents: snapshot.balancingDifferenceCents,
      trigger: "schedule",
      startedAt,
      source: "nightly",
    });
    return { periodEnd, tasksCreated, tasksClosed: reconciled.completed, tasksReopened: reconciled.reopened, errors: snapshot.errors };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[balance-close] could not refresh an older open month", { periodEnd, err });
    await recordRecalculation(supabase, {
      periodEnd,
      errors: [message],
      balancingDifferenceCents: null,
      trigger: "schedule",
      startedAt,
      source: "nightly",
    });
    return { periodEnd, tasksCreated: 0, tasksClosed: 0, tasksReopened: 0, errors: [message] };
  }
}

export async function runBalanceClose(supabase: SupabaseClient) {
  const todayIso = todayLocalDate();
  const periodEnd = mostRecentlyEndedMonthEnd(todayIso);

  const tasksCreated = await ensureTasksForPeriod(supabase, periodEnd);
  const snapshot = await snapshotPeriod(supabase, periodEnd);
  const reconciled = await reconcileCloseTasks(supabase, periodEnd);

  // Record what re-anchoring absorbed on any Square-derived account that has
  // now been closed. Isolated from the rest of the run: this is an audit
  // record, and losing it must never cost the freeze decision or the alert.
  // It runs AFTER reconcileCloseTasks so a balance entered since the last run
  // is already visible.
  let driftsRecorded = 0;
  try {
    for (const coaId of await squareBalanceAccountIds(supabase)) {
      if (await recordSquareDrift(supabase, coaId, periodEnd)) driftsRecorded++;
    }
  } catch (err) {
    console.error("[balance-close] failed to record Square drift", { periodEnd, err });
  }

  const tasks = await listTasksForPeriod(supabase, periodEnd);

  // No reminder email goes out from here. Accounts still missing a balance
  // are listed on the Home alert center and in the morning alert digest
  // (lib/alerts/sources/finance.ts) every day until they are entered.
  const { dueDay } = await readCloseConfig(supabase);

  // Reported, never acted on. A period whose checklist is finished but which
  // nobody has closed is the state this whole change exists to make visible:
  // previously it was frozen on the operator's behalf and looked identical to
  // a month somebody had actually signed off.
  const closeState = await readPeriodClose(supabase, periodEnd);
  const closed = closeState?.closed ?? false;

  // Every other month still open, newest first. After the latest month on
  // purpose: its result is the one this job has always reported, and nothing
  // an older month does may cost it.
  const olderOpen = (await listOpenPeriodEnds(supabase, todayIso))
    .filter((p) => p !== periodEnd)
    .reverse()
    .slice(0, MAX_OLDER_MONTHS_PER_RUN);
  const olderOpenMonths = [];
  for (const older of olderOpen) olderOpenMonths.push(await refreshOlderOpenMonth(supabase, older));

  return {
    periodEnd,
    tasksCreated,
    tasksClosed: reconciled.completed,
    tasksReopened: reconciled.reopened,
    driftsRecorded,
    closed,
    readyToClose: !closed && everyTaskAnswered(tasks) && snapshot.errors.length === 0,
    // Derived from CONFIG, not from tasks[0] -- with zero tasks there is no
    // tasks[0], which is precisely where the old freeze rule fell through to a
    // vacuous truth and froze the month on day one.
    pastDue: todayIso > dueDateForPeriod(periodEnd, dueDay),
    snapshot,
    olderOpenMonths,
  };
}

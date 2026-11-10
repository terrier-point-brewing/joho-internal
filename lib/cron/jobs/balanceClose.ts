/**
 * Closes the most recently ENDED month (i.e. the month before the one the run
 * date falls in -- the current month is still in progress and shouldn't be
 * snapshotted yet). In order:
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
  };
}

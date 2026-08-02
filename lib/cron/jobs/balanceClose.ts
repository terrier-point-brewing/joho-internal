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
 *   4. Alert -- for every task that has crossed its due_date -
 *      alert_lead_days threshold and hasn't been alerted yet, one email to
 *      each responsible person listing their own accounts. Anything with
 *      nobody named still goes to the admin address.
 * ── What this job deliberately does NOT do ───────────────────────────────────
 * It does not freeze anything. It used to, once every task was done OR the due
 * date had passed, and that second condition turned "the deadline went by" into
 * "these books are final" -- a claim no unattended job is in a position to
 * make. June 2026 was frozen that way with 6 of 45 accounts carrying a balance.
 *
 * Freezing is now the close action in lib/finance/balances/periodClose.ts,
 * performed by a person whose name goes on it. What this run contributes is the
 * evidence they close on: fresh figures, a current checklist, and an email when
 * something is late. It reports `readyToClose` so a period that is finished but
 * unclosed is visible rather than silently rolling on.
 *
 * runCronJob wraps the whole thing so a run lands in cron_runs for the
 * Settings > Cron Jobs monitor, success or failure.
 *
 * One thing to know before running it by hand: it sends email, on the same
 * "only tasks not yet alerted" rule as the tax job. Nothing it does is
 * irreversible -- since the freeze moved out, a manual run is a refresh.
 */
import "@/lib/finance/balances/methods";
import type { SupabaseClient } from "@supabase/supabase-js";
import { snapshotPeriod } from "@/lib/finance/balances/snapshot";
import {
  ensureTasksForPeriod,
  listTasksForPeriod,
  reconcileCloseTasks,
  tasksNeedingAlert,
  markAlerted,
  everyTaskAnswered,
  dueDateForPeriod,
  readCloseConfig,
  resolveResponsibleEmails,
} from "@/lib/finance/balances/closeTasks";
import { readPeriodClose } from "@/lib/finance/balances/periodClose";
import { recordSquareDrift, squareBalanceAccountIds } from "@/lib/finance/balances/squareDrift";
import { renderBalanceCloseEmail } from "@/lib/finance/balances/alertEmail";
import { sendEmail, ADMIN_EMAIL } from "@/lib/resend";
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

  const { alertLeadDays, dueDay } = await readCloseConfig(supabase);
  const alertCandidates = tasksNeedingAlert(tasks, todayIso, alertLeadDays);

  let alertsSent = 0;
  if (alertCandidates.length > 0) {
    try {
      const coaIds = alertCandidates.map((t) => t.coaId);
      const [{ data: coaRows, error: coaError }, responsibleEmails] = await Promise.all([
        supabase.from("chart_of_accounts").select("id, account_name, account_number").in("id", coaIds),
        resolveResponsibleEmails(supabase, coaIds),
      ]);
      if (coaError) throw new Error(coaError.message);

      const coaById = new Map(
        ((coaRows ?? []) as { id: string; account_name: string; account_number: string | null }[]).map((r) => [
          r.id,
          { accountName: r.account_name, accountNumber: r.account_number },
        ]),
      );

      // Grouped by recipient, so each person gets ONE email listing their own
      // accounts -- the same shape as the single combined email this replaces,
      // addressed to whoever actually has to act on it. An account with nobody
      // named still lands at the admin address rather than going nowhere.
      const byRecipient = new Map<string, typeof alertCandidates>();
      for (const t of alertCandidates) {
        const to = responsibleEmails.get(t.coaId) ?? ADMIN_EMAIL;
        const bucket = byRecipient.get(to);
        if (bucket) bucket.push(t);
        else byRecipient.set(to, [t]);
      }

      for (const [to, tasksForPerson] of byRecipient) {
        const missing = tasksForPerson.map((t) => ({
          accountName: coaById.get(t.coaId)?.accountName ?? t.coaId,
          accountNumber: coaById.get(t.coaId)?.accountNumber ?? null,
          dueDate: t.dueDate,
        }));
        const unassigned = tasksForPerson.every((t) => !responsibleEmails.has(t.coaId));
        const { subject, html } = renderBalanceCloseEmail(missing, periodEnd, unassigned);

        // Marked per recipient, inside the loop: a send that failed for one
        // person must stay unmarked so the next run retries it, without
        // re-alerting everybody who already received theirs.
        await sendEmail(to, subject, html);
        await markAlerted(supabase, tasksForPerson.map((t) => t.id));
        alertsSent += tasksForPerson.length;
      }
    } catch (err) {
      // Isolate an alert failure (e.g. a Resend outage) so it never blocks the
      // rest of the run -- unalerted tasks simply retry next run.
      console.error("[balance-close] failed to send/mark alert", { periodEnd, err });
    }
  }

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
    alertsSent,
    closed,
    readyToClose: !closed && everyTaskAnswered(tasks) && snapshot.errors.length === 0,
    // Derived from CONFIG, not from tasks[0] -- with zero tasks there is no
    // tasks[0], which is precisely where the old freeze rule fell through to a
    // vacuous truth and froze the month on day one.
    pastDue: todayIso > dueDateForPeriod(periodEnd, dueDay),
    snapshot,
  };
}

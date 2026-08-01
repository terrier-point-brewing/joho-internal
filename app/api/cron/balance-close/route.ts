/**
 * Daily cron for the most recently ENDED month (i.e. the month before the
 * one the run date falls in -- the current month is still in progress and
 * shouldn't be snapshotted yet). In order:
 *
 *   1. ensureTasksForPeriod  -- create a close task for every active
 *      manualBalance-sourced account still missing a balance for the period.
 *   2. snapshotPeriod        -- recompute every non-frozen gl_account_balances
 *      row for the period from the registered providers.
 *   3. reconcileCloseTasks   -- close any task whose manual_entries balance
 *      row has since appeared (the manual-entries route also calls this
 *      immediately on write; this catches anything entered directly in the
 *      DB or between runs).
 *   3b. recordSquareDrift    -- for any Square-derived account now closed,
 *      log what the derivation predicted against what the operator actually
 *      found. Re-anchoring silently absorbs its own errors; this is the only
 *      record that it did.
 *   4. Alert -- one combined email for every task that has crossed its
 *      due_date - alert_lead_days threshold and hasn't been alerted yet.
 *   5. freezePeriod once the period is fully closed (every task completed/
 *      skipped) OR its due date has passed -- a period must eventually stop
 *      accepting recomputation even if a task was never fulfilled.
 *
 * runCronJob wraps the whole thing so a run lands in cron_runs for the
 * Settings > Cron Jobs monitor, success or failure.
 */
import "@/lib/finance/balances/methods";
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { runCronJob } from "@/lib/cron/runCronJob";
import { snapshotPeriod, freezePeriod } from "@/lib/finance/balances/snapshot";
import {
  ensureTasksForPeriod,
  listTasksForPeriod,
  reconcileCloseTasks,
  tasksNeedingAlert,
  markAlerted,
  isPeriodClosed,
  dueDateForPeriod,
  readCloseConfig,
} from "@/lib/finance/balances/closeTasks";
import { recordSquareDrift, squareBalanceAccountIds } from "@/lib/finance/balances/squareDrift";
import { renderBalanceCloseEmail } from "@/lib/finance/balances/alertEmail";
import { sendEmail, ADMIN_EMAIL } from "@/lib/resend";
import { todayLocalDate } from "@/lib/utils/datetime";
import { apiError } from "@/lib/utils/api";
// Shared with the integration connect-time check, which must validate the SAME
// period this cron reads. It previously had its own copy resolved in UTC.
import { mostRecentlyEndedMonthEnd } from "@/lib/finance/balances/periods";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const outcome = await runCronJob("balance-close", async () => {
    const supabase = createSupabaseAdminClient();
    const todayIso = todayLocalDate();
    const periodEnd = mostRecentlyEndedMonthEnd(todayIso);

    const tasksCreated = await ensureTasksForPeriod(supabase, periodEnd);
    const snapshot = await snapshotPeriod(supabase, periodEnd);
    const tasksClosed = await reconcileCloseTasks(supabase, periodEnd);

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
        const { data: coaRows, error: coaError } = await supabase
          .from("chart_of_accounts")
          .select("id, account_name, account_number")
          .in("id", coaIds);
        if (coaError) throw new Error(coaError.message);

        const coaById = new Map(
          ((coaRows ?? []) as { id: string; account_name: string; account_number: string | null }[]).map((r) => [
            r.id,
            { accountName: r.account_name, accountNumber: r.account_number },
          ]),
        );

        const missing = alertCandidates.map((t) => ({
          accountName: coaById.get(t.coaId)?.accountName ?? t.coaId,
          accountNumber: coaById.get(t.coaId)?.accountNumber ?? null,
          dueDate: t.dueDate,
        }));

        const { subject, html } = renderBalanceCloseEmail(missing, periodEnd);
        await sendEmail(ADMIN_EMAIL, subject, html);
        await markAlerted(supabase, alertCandidates.map((t) => t.id));
        alertsSent = alertCandidates.length;
      } catch (err) {
        // Isolate an alert failure (e.g. a Resend outage) so it never blocks
        // the freeze decision below -- unalerted tasks simply retry next run.
        console.error("[balance-close] failed to send/mark alert", { periodEnd, err });
      }
    }

    // Derive the due date from CONFIG, not from tasks[0] -- with zero tasks
    // there is no tasks[0], which is precisely when the old code fell through
    // to isPeriodClosed's vacuous truth and froze the month on day one.
    const pastDueDate = todayIso > dueDateForPeriod(periodEnd, dueDay);
    let frozen = false;
    if (isPeriodClosed(tasks) || pastDueDate) {
      await freezePeriod(supabase, periodEnd);
      frozen = true;
    }

    return {
      periodEnd,
      tasksCreated,
      tasksClosed,
      driftsRecorded,
      alertsSent,
      frozen,
      snapshot,
    };
  });

  return outcome.ok ? NextResponse.json(outcome.detail) : apiError(outcome.error);
}

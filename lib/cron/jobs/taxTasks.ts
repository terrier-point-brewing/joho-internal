/**
 * Keeps `tax_tasks` in sync with every active `tax_schedules` row (idempotent —
 * `ensureTasksForSchedule` upserts on (schedule_id, period_end) with
 * `ignoreDuplicates: true`), then fires the lead-time alert email for any open
 * task that has crossed its `due_date - lead_days` threshold and hasn't been
 * alerted yet (`tasksNeedingAlert` / `markAlerted`, both in lib/tax/tasks.ts).
 *
 * `import "@/lib/tax/parties"` is required for its side effect: each party
 * template registers itself with lib/tax/registry on module load, so `getParty`
 * below can resolve `nc_dor_sales_use` (and any future party).
 *
 * Worth knowing before pressing "Run now": this job sends email. Re-running it
 * will not re-alert anyone, because a task is marked the moment its alert goes
 * out and only unalerted tasks are candidates — but it can send an alert that
 * would otherwise have waited until tomorrow morning.
 */
import "@/lib/tax/parties";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listSchedules } from "@/lib/tax/schedules";
import { ensureTasksForSchedule, tasksNeedingAlert, markAlerted } from "@/lib/tax/tasks";
import { getParty } from "@/lib/tax/registry";
import { renderTaxAlertEmail } from "@/lib/tax/alertEmail";
import { sendEmail, ADMIN_EMAIL } from "@/lib/resend";
import type { TaxSchedule } from "@/lib/tax/types";

// How far back `ensureTasksForSchedule` looks for periods that concluded but
// don't have a task row yet. 120 days comfortably covers a missed quarterly
// period (~90 days) plus slack for a cron outage, without the cost of the
// lib default (400 days, sized for a worst-case annual party) on every daily
// run — annual schedules are rare and get caught by the next run within the
// 120-day window regardless, since ensureTasksForSchedule is idempotent.
const LOOKBACK_DAYS = 120;

export async function runTaxTasks(supabase: SupabaseClient) {
  const now = new Date();

  const schedules = await listSchedules(supabase, { activeOnly: true });
  const scheduleById = new Map<string, TaxSchedule>(schedules.map((s) => [s.id, s]));

  let tasksCreated = 0;
  for (const schedule of schedules) {
    const { created } = await ensureTasksForSchedule(supabase, schedule, now, LOOKBACK_DAYS);
    tasksCreated += created;
  }

  const alertCandidates = await tasksNeedingAlert(supabase, now);
  let alertsSent = 0;
  for (const task of alertCandidates) {
    // Reuse the schedules already fetched above rather than refetching one
    // row per task; if a task's schedule was deactivated/deleted between
    // the two loops (or predates this run), skip it rather than crash the
    // whole job.
    const schedule = scheduleById.get(task.schedule_id);
    if (!schedule) {
      console.error("[tax-tasks] no active schedule found for task", { taskId: task.id, scheduleId: task.schedule_id });
      continue;
    }

    try {
      const party = getParty(task.party_key);
      const { subject, html } = renderTaxAlertEmail(task, party, schedule);
      await sendEmail(ADMIN_EMAIL, subject, html);
      await markAlerted(supabase, task.id);
      alertsSent++;
    } catch (err) {
      // Isolate one task's send/mark failure (e.g. a Resend outage) so it
      // doesn't abort the loop and silently defer every other due task's
      // alert this run. markAlerted is inside the try, so a failed send
      // never marks the task alerted — it stays a candidate and retries
      // next run.
      console.error("[tax-tasks] failed to send/mark alert for task", { taskId: task.id, scheduleId: task.schedule_id, err });
      continue;
    }
  }

  return {
    schedules: schedules.length,
    tasksCreated,
    alertsSent,
  };
}

/**
 * Keeps `tax_tasks` in sync with every active `tax_schedules` row (idempotent —
 * `ensureTasksForSchedule` upserts on (schedule_id, period_end) with
 * `ignoreDuplicates: true`).
 *
 * This job sends no email. A filing approaching its due date is listed on the
 * Home alert center and in the morning alert digest (lib/alerts/sources/finance.ts)
 * every day until it is completed, which replaces the one-off lead-time alert
 * this job used to fire.
 *
 * `import "@/lib/tax/parties"` is required for its side effect: each party
 * template registers itself with lib/tax/registry on module load.
 */
import "@/lib/tax/parties";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listSchedules } from "@/lib/tax/schedules";
import { ensureTasksForSchedule } from "@/lib/tax/tasks";

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

  let tasksCreated = 0;
  for (const schedule of schedules) {
    const { created } = await ensureTasksForSchedule(supabase, schedule, now, LOOKBACK_DAYS);
    tasksCreated += created;
  }

  return {
    schedules: schedules.length,
    tasksCreated,
  };
}

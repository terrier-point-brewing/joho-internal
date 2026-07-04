/**
 * Registry of scheduled (Vercel cron) jobs, used by the Settings → Cron Jobs
 * monitor to list every job even before it has run. The actual schedules live
 * in vercel.json — keep the `schedule` values here in sync with that file.
 */
export interface CronJobMeta {
  /** Stable id, also the `job` value written to cron_runs. */
  job:           string;
  path:          string;
  schedule:      string;   // cron expression, mirrors vercel.json
  scheduleLabel: string;   // human-readable
  description:   string;
  /** Flag the job as overdue if its last successful run is older than this. */
  maxAgeHours:   number;
}

export const CRON_JOBS: CronJobMeta[] = [
  {
    job:           "payroll-advance",
    path:          "/api/cron/payroll-advance",
    schedule:      "0 5 * * *",
    scheduleLabel: "Daily · 05:00 UTC",
    description:   "Creates the next open pay period ahead of time.",
    maxAgeHours:   25,
  },
  {
    job:           "ramp-expenses-sync",
    path:          "/api/cron/ramp-expenses-sync",
    schedule:      "30 6 * * *",
    scheduleLabel: "Daily · 06:30 UTC",
    description:   "Imports recent Ramp expenses and auto-maps them to the chart of accounts.",
    maxAgeHours:   25,
  },
  {
    job:           "taproom-consumption-sync",
    path:          "/api/cron/taproom-consumption-sync",
    schedule:      "0 7 * * *",
    scheduleLabel: "Daily · 07:00 UTC",
    description:   "Reconciles taproom pours (keg/can sales + draft keg-swaps) from Square into taproom shipments that drain cold storage.",
    maxAgeHours:   25,
  },
];

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
  {
    job:           "finance-sync",
    path:          "/api/cron/finance-sync",
    schedule:      "30 7 * * *",
    scheduleLabel: "Daily · 07:30 UTC",
    description:   "Safety net for the Square webhook: re-syncs a trailing window of orders, refunds, and invoices into the finance transactions grid.",
    maxAgeHours:   25,
  },
  {
    job:           "finance-gap-scan",
    path:          "/api/cron/finance-gap-scan",
    schedule:      "0 8 * * 1",
    scheduleLabel: "Weekly · Mon 08:00 UTC",
    description:   "Compares per-day Square order counts against persisted orders over a long lookback and re-syncs only the days that disagree — catches gaps the nightly window is too short to reach.",
    // Weekly job: overdue only once a run has been missed outright (8 days).
    maxAgeHours:   193,
  },
  {
    job:           "tax-tasks",
    path:          "/api/cron/tax-tasks",
    schedule:      "0 8 * * *",
    scheduleLabel: "Daily · 08:00 UTC",
    description:   "Keeps tax_tasks in sync with active tax schedules and fires lead-time alert emails for tasks approaching their due date.",
    maxAgeHours:   25,
  },
];

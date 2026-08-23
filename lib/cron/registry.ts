/**
 * Registry of scheduled (Vercel cron) jobs, used by the Settings → Cron Jobs
 * monitor to list every job even before it has run. The actual schedules live
 * in vercel.json — keep the `schedule` values here in sync with that file.
 *
 * Description only. What each job actually DOES is paired with the entry here in
 * lib/cron/jobs/index.ts, which is deliberately a separate module: this one is
 * serialised straight to the browser by the monitor's API route, and it must not
 * drag every sync in the application into that route's import graph.
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
  /**
   * What a "Run now" answers with.
   *
   * "wait" — the request runs the job and answers with its result. Only for
   * jobs that reliably finish in the time a person will hold a page open.
   *
   * "start" — the request answers immediately and the job carries on behind it.
   * For the jobs that page against a bank or against Square and can take
   * minutes; the monitor's history is where the outcome shows up. Nothing about
   * the run differs, only what the browser is told.
   */
  manualRun:     "wait" | "start";
  /**
   * What someone should know before pressing the button, in full sentences.
   * Absent when there is nothing beyond the description to say.
   */
  manualNote?:   string;
}

export const CRON_JOBS: CronJobMeta[] = [
  {
    job:           "balance-capture",
    path:          "/api/cron/balance-capture",
    schedule:      "0 2 * * *",
    // 02:00 UTC is late evening the PREVIOUS day at the brewery, which is the
    // date the reading is filed under — see the route header.
    scheduleLabel: "Daily · 02:00 UTC (late evening ET)",
    description:   "Records each Plaid-linked bank account's balance for the day. Plaid cannot be asked for a past balance, so a month end with no capture stays unsourced rather than being approximated from a nearby day.",
    maxAgeHours:   25,
    manualRun:     "start",
    manualNote:    "This records today's balance. A balance for a day that was missed cannot be recovered afterwards, because the bank only ever answers for the present moment.",
  },
  {
    job:           "bank-transactions-sync",
    path:          "/api/cron/bank-transactions-sync",
    schedule:      "0 3 * * *",
    scheduleLabel: "Daily · 03:00 UTC",
    description:   "Imports bank transactions from Plaid so Square's transfers out of its own balance can be recognised on the receiving side. These are not ledger postings and do not affect the profit and loss.",
    maxAgeHours:   25,
    manualRun:     "start",
    manualNote:    "The first run after a bank is connected can take several minutes, because it walks up to two years of history. Later runs are quick. A transaction that has already been given an account by hand keeps it.",
  },
  {
    job:           "payroll-advance",
    path:          "/api/cron/payroll-advance",
    schedule:      "0 5 * * *",
    scheduleLabel: "Daily · 05:00 UTC",
    description:   "Creates the next open pay period ahead of time.",
    maxAgeHours:   25,
    manualRun:     "wait",
  },
  {
    job:           "ramp-expenses-sync",
    path:          "/api/cron/ramp-expenses-sync",
    schedule:      "30 6 * * *",
    scheduleLabel: "Daily · 06:30 UTC",
    description:   "Imports recent Ramp expenses and auto-maps them to the chart of accounts.",
    maxAgeHours:   25,
    manualRun:     "wait",
    manualNote:    "An expense that turns out to be a transfer between accounts is removed so nothing is counted twice. One that has been split by hand, excluded, or matched to a pay period is kept.",
  },
  {
    job:           "square-catalog-sync",
    path:          "/api/cron/square-catalog-sync",
    // Ahead of the two jobs that read the mirror: the consumption sync at 07:00
    // and the inventory push at 07:15.
    schedule:      "45 6 * * *",
    scheduleLabel: "Daily · 06:45 UTC",
    description:   "Refreshes the local copy of the Square catalogue: item and price names, and which products Square has retired. Nothing else can tell that a product was retired, because Square only ever reports what still exists.",
    maxAgeHours:   25,
    manualRun:     "start",
    manualNote:    "Safe to run at any time. It never changes the pour size recorded for a product — that figure is what past sales were measured against, so a product renamed in Square is reported for someone to look at rather than changed here. A product newly linked to a recipe is copied over the moment it is linked and does not wait for this.",
  },
  {
    job:           "taproom-consumption-sync",
    path:          "/api/cron/taproom-consumption-sync",
    schedule:      "0 7 * * *",
    scheduleLabel: "Daily · 07:00 UTC",
    description:   "Reconciles taproom pours (keg/can sales + draft keg-swaps) from Square into taproom shipments that drain cold storage.",
    maxAgeHours:   25,
    manualRun:     "wait",
    manualNote:    "This drains cold storage for what was poured and can change stock counts in Square. Anything already recorded is not recorded again.",
  },
  {
    job:           "square-inventory-push",
    path:          "/api/cron/square-inventory-push",
    schedule:      "15 7 * * *",
    scheduleLabel: "Daily · 07:15 UTC",
    description:   "Reflects cold storage onto Square for every mapped keg and can SKU, so Square's counts include stock that arrived as well as stock that sold.",
    maxAgeHours:   25,
    manualRun:     "wait",
    manualNote:    "Runs right after the consumption sync so it restates counts once that has drained what was poured. While the push is in observe-only mode it measures and reports without changing anything in Square.",
  },
  {
    job:           "finance-sync",
    path:          "/api/cron/finance-sync",
    schedule:      "30 7 * * *",
    scheduleLabel: "Daily · 07:30 UTC",
    description:   "Safety net for the Square webhook: re-syncs a trailing window of orders, refunds, and invoices into the finance transactions grid.",
    maxAgeHours:   25,
    manualRun:     "start",
    manualNote:    "An account set by hand is kept, on order lines and on invoice lines alike. What re-syncing changes is the money and the line details, which come from Square.",
  },
  {
    job:           "finance-gap-scan",
    path:          "/api/cron/finance-gap-scan",
    schedule:      "0 8 * * 1",
    scheduleLabel: "Weekly · Mon 08:00 UTC",
    description:   "Compares per-day Square order counts against persisted orders over a long lookback and re-syncs only the days that disagree — catches gaps the nightly window is too short to reach.",
    // Weekly job: overdue only once a run has been missed outright (8 days).
    maxAgeHours:   193,
    manualRun:     "start",
    manualNote:    "On a healthy set of books this finds nothing and changes nothing. Where it does find a missing day it re-syncs that day, keeping any account set by hand on the lines it rebuilds.",
  },
  {
    job:           "tax-tasks",
    path:          "/api/cron/tax-tasks",
    schedule:      "0 8 * * *",
    scheduleLabel: "Daily · 08:00 UTC",
    description:   "Keeps tax_tasks in sync with active tax schedules and fires lead-time alert emails for tasks approaching their due date.",
    maxAgeHours:   25,
    manualRun:     "wait",
    manualNote:    "This can send a reminder email that would otherwise have waited until tomorrow morning. Nobody is reminded twice, and work already entered against a filing is left alone.",
  },
  {
    job:           "balance-close",
    path:          "/api/cron/balance-close",
    schedule:      "0 9 * * *",
    scheduleLabel: "Daily · 09:00 UTC",
    description:   "Closes the most recently ended month: opens close tasks for manual-balance accounts, re-snapshots GL account balances, emails a reminder for balances still missing near their due date, and freezes the period once it's done or past due.",
    maxAgeHours:   25,
    manualRun:     "wait",
    manualNote:    "This can send reminder emails, and once the month's due date has passed it also freezes the month, which stops its figures being recalculated. A month that is already frozen is left alone.",
  },
  {
    job:           "marketing-deliveries",
    path:          "/api/cron/marketing-deliveries",
    // Daily, and deliberately so — the Vercel Hobby plan this project runs on
    // refuses any sub-daily cron outright (the deployment is rejected at config
    // validation, before a build even starts), so "*/5 * * * *" is not a thing
    // that can ship here.
    //
    // Daily is the right cadence for what this job currently does rather than a
    // sad compromise. There is no scheduling UI: an entry is published by Post
    // now, which runs the worker INLINE and returns, so the ordinary path never
    // waits on this job at all. The sweep exists to catch a delivery whose
    // inline run died mid-flight. When scheduling ships and a post can be booked
    // for Thursday at 9am, this becomes a real constraint and the plan question
    // reopens — until then it is not one.
    schedule:      "0 10 * * *",
    scheduleLabel: "Daily · 10:00 UTC",
    description:   "Sweeps up marketing deliveries that were left unpublished — normally one whose inline publish died mid-flight. Publishing itself happens immediately when a person presses Post now. A delivery that fails stays failed until a person retries it; nothing is ever re-sent automatically.",
    maxAgeHours:   25,
    manualRun:     "wait",
    manualNote:    "This posts publicly, straight away, to every connected channel with an entry that is due. A post cannot be taken back once it has gone out. Anything already published is recognised and not sent a second time, and an entry whose time has not yet come is left alone.",
  },
];

/**
 * The one place a job is defined: its name and schedule metadata from the
 * registry, paired with the function that does the work.
 *
 * Before this, a job existed twice — the registry knew its name and schedule,
 * and the route file held its body — so nothing but the cron path could run one.
 * Now the scheduled route and the "Run now" button are two callers of the same
 * definition, which is what makes a manual run and a nightly run the same run.
 *
 * Kept apart from lib/cron/registry.ts on purpose. That module is serialised to
 * the browser by the monitor's API route; this one reaches into Square, Plaid,
 * Ramp and the mail sender, and must stay on the server side of that line.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { CRON_JOBS, type CronJobMeta } from "@/lib/cron/registry";
import { runBalanceCapture } from "./balanceCapture";
import { runBalanceClose } from "./balanceClose";
import { runBankTransactionsSync } from "./bankTransactionsSync";
import { runFinanceGapScan } from "./financeGapScan";
import { runFinanceSync } from "./financeSync";
import { runPayrollAdvance } from "./payrollAdvance";
import { runRampExpensesSync } from "./rampExpensesSync";
import { runTaproomConsumptionJob } from "./taproomConsumptionSync";
import { runTaxTasks } from "./taxTasks";

/** What a job's work looks like. The admin client is the only argument any of them needs. */
export type CronJobWork = (supabase: SupabaseClient) => Promise<unknown>;

export interface CronJobDefinition extends CronJobMeta {
  run: CronJobWork;
}

/**
 * Keyed by the same id the registry and cron_runs use.
 *
 * Every entry in CRON_JOBS must appear here — assertEveryJobIsRunnable below
 * turns a missing one into a failing test rather than a button that answers
 * "no such job" in production.
 */
const WORK_BY_JOB: Record<string, CronJobWork> = {
  "balance-capture":          runBalanceCapture,
  "balance-close":            runBalanceClose,
  "bank-transactions-sync":   runBankTransactionsSync,
  "finance-gap-scan":         runFinanceGapScan,
  "finance-sync":             runFinanceSync,
  "payroll-advance":          runPayrollAdvance,
  "ramp-expenses-sync":       runRampExpensesSync,
  "taproom-consumption-sync": runTaproomConsumptionJob,
  "tax-tasks":                runTaxTasks,
};

/** Every job, metadata and work together, in the registry's order. */
export const CRON_JOB_DEFINITIONS: CronJobDefinition[] = CRON_JOBS.map((meta) => ({
  ...meta,
  run: WORK_BY_JOB[meta.job],
})).filter((d): d is CronJobDefinition => typeof d.run === "function");

/**
 * The definition for a job id, or undefined for an id nothing knows about.
 *
 * Undefined rather than a throw: the id reaching this comes off a request, and a
 * caller asking for a job that does not exist deserves a 404, not a 500.
 */
export function getCronJob(job: string): CronJobDefinition | undefined {
  return CRON_JOB_DEFINITIONS.find((d) => d.job === job);
}

/** Registry entries with no work attached. Empty is the only acceptable answer. */
export function jobsWithoutWork(): string[] {
  return CRON_JOBS.filter((m) => typeof WORK_BY_JOB[m.job] !== "function").map((m) => m.job);
}

/**
 * Month-end close checklist for balance-sheet accounts that need a human to
 * supply a balance before a period is final: one balance_close_tasks row per
 * active account whose source requires an operator figure and that lacks a
 * manual_entries balance row for that period_end.
 *
 * That set is `manualBalance` plus any method declaring requiresCloseEntry --
 * see requiresOperatorBalance. The second case is not hypothetical: the Square
 * balance method derives its own movement but still needs a person to re-anchor
 * it every month, because the outflow half of that account is observable in no
 * feed at all.
 *
 * Mirrors lib/tax/tasks.ts's structure and idioms almost function-for-
 * function: idempotent ensure via upsert(..., { ignoreDuplicates: true }),
 * a pure alert-eligibility predicate, DB wrappers taking an injected
 * SupabaseClient first, same as lib/tax/backfillLineItemTaxes.ts.
 *
 * Tasks are NEVER completed by hand -- there is no "complete task" write
 * path here. reconcileCloseTasks is the only function that flips a task to
 * "completed", and it does so exclusively because the corresponding
 * manual_entries balance row now exists (see manualBalance.ts and
 * app/api/finance/manual-entries/route.ts, which calls this after every
 * successful balance-kind write so a task clears immediately).
 */
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { resolveDueDate } from "@/lib/tax/dueDate";
import { addDaysIso } from "@/lib/tax/period";
import { getMethod } from "./methods/registry";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

export type CloseTaskStatus = "open" | "completed" | "skipped";

export interface CloseTask {
  id: string;
  coaId: string;
  periodEnd: string;
  dueDate: string;
  status: CloseTaskStatus;
  alertSentAt: string | null;
}

interface CloseTaskRow {
  id: string;
  chart_of_accounts_id: string;
  period_end: string;
  due_date: string;
  status: CloseTaskStatus;
  alert_sent_at: string | null;
}

function toCloseTask(row: CloseTaskRow): CloseTask {
  return {
    id: row.id,
    coaId: row.chart_of_accounts_id,
    periodEnd: row.period_end,
    dueDate: row.due_date,
    status: row.status,
    alertSentAt: row.alert_sent_at,
  };
}

const CLOSE_CONFIG_KEY = "balance_sheet_close";
const DEFAULT_DUE_DAY = 5;
const DEFAULT_ALERT_LEAD_DAYS = 0;

export interface CloseConfig {
  dueDay: number;
  alertLeadDays: number;
}

/** Reads system_settings['balance_sheet_close'], falling back to the migration's seeded defaults if the row is (somehow) missing. */
export async function readCloseConfig(supabase: AdminClient): Promise<CloseConfig> {
  const { data, error } = await supabase
    .from("system_settings")
    .select("value")
    .eq("key", CLOSE_CONFIG_KEY)
    .maybeSingle();
  if (error) throw new Error(error.message);

  const value = (data as { value?: { due_day?: number; alert_lead_days?: number } } | null)?.value ?? {};
  return {
    dueDay: value.due_day ?? DEFAULT_DUE_DAY,
    alertLeadDays: value.alert_lead_days ?? DEFAULT_ALERT_LEAD_DAYS,
  };
}

/**
 * Idempotently creates a balance_close_tasks row for every active
 * manualBalance-sourced account that has no manual_entries balance row for
 * `periodEnd` yet. due_date = the configured due_day applied to the month
 * AFTER periodEnd (resolveDueDate with monthOffset: 1 reuses the exact
 * calendar math lib/tax/dueDate.ts already owns).
 *
 * Idempotency comes from upsert(..., { onConflict: "chart_of_accounts_id,
 * period_end", ignoreDuplicates: true }): a re-run leaves an existing task's
 * status untouched, and select("id") after an ignore-duplicates upsert
 * returns only the rows actually inserted.
 */
/**
 * Whether a selected source needs a person to supply a figure before the period
 * can be called closed.
 *
 * "manualBalance" is matched by name because it predates the method layer and
 * appears in balance_sheet_account_sources as a bare provider key. Everything
 * else is asked of the method registry, so a method declaring
 * requiresCloseEntry gets a close task without this function learning its name.
 *
 * An unregistered key answers false rather than throwing: this runs first in
 * the close cron, and refusing to create ANY task because one source names
 * something unknown would be a worse failure than the unknown source itself.
 */
export function requiresOperatorBalance(providerKey: string): boolean {
  if (providerKey === "manualBalance") return true;
  return getMethod(providerKey)?.requiresCloseEntry === true;
}

export async function ensureTasksForPeriod(supabase: AdminClient, periodEnd: string): Promise<number> {
  const { data: sourceRows, error: sourcesError } = await supabase
    .from("balance_sheet_account_sources")
    .select("chart_of_accounts_id, provider_key")
    .eq("active", true);
  if (sourcesError) throw new Error(sourcesError.message);

  const coaIds = Array.from(
    new Set(
      ((sourceRows ?? []) as { chart_of_accounts_id: string; provider_key: string }[])
        .filter((r) => requiresOperatorBalance(r.provider_key))
        .map((r) => r.chart_of_accounts_id),
    ),
  );
  if (coaIds.length === 0) return 0;

  const { data: entryRows, error: entriesError } = await supabase
    .from("manual_entries")
    .select("chart_of_accounts_id")
    .eq("entry_kind", "balance")
    .eq("as_of_date", periodEnd)
    .in("chart_of_accounts_id", coaIds);
  if (entriesError) throw new Error(entriesError.message);

  const covered = new Set(((entryRows ?? []) as { chart_of_accounts_id: string }[]).map((r) => r.chart_of_accounts_id));
  const needing = coaIds.filter((id) => !covered.has(id));
  if (needing.length === 0) return 0;

  const { dueDay } = await readCloseConfig(supabase);
  const dueDate = resolveDueDate(periodEnd, { monthOffset: 1, day: dueDay });

  const rows = needing.map((coaId) => ({
    chart_of_accounts_id: coaId,
    period_end: periodEnd,
    due_date: dueDate,
  }));

  const { data, error } = await supabase
    .from("balance_close_tasks")
    .upsert(rows, { onConflict: "chart_of_accounts_id,period_end", ignoreDuplicates: true })
    .select("id");
  if (error) throw new Error(error.message);

  return (data ?? []).length;
}

/** Every balance_close_tasks row for `periodEnd`, mapped to the CloseTask shape. */
export async function listTasksForPeriod(supabase: AdminClient, periodEnd: string): Promise<CloseTask[]> {
  const { data, error } = await supabase
    .from("balance_close_tasks")
    .select("id, chart_of_accounts_id, period_end, due_date, status, alert_sent_at")
    .eq("period_end", periodEnd);
  if (error) throw new Error(error.message);

  return ((data ?? []) as CloseTaskRow[]).map(toCloseTask);
}

/** Pure. Open, not-yet-alerted tasks whose dueDate - leadDays threshold has been reached (todayIso is on/after it). */
export function tasksNeedingAlert(tasks: CloseTask[], todayIso: string, leadDays: number): CloseTask[] {
  return tasks.filter((task) => {
    if (task.status !== "open") return false;
    if (task.alertSentAt) return false;
    return todayIso >= addDaysIso(task.dueDate, -leadDays);
  });
}

export async function markAlerted(supabase: AdminClient, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await supabase
    .from("balance_close_tasks")
    .update({ alert_sent_at: new Date().toISOString() })
    .in("id", ids);
  if (error) throw new Error(error.message);
}

/**
 * Closes every open balance_close_tasks row for `periodEnd` whose account
 * now has a manual_entries balance row for that same period_end. The ONLY
 * write path that ever marks a task completed -- see this module's header.
 * Returns the number of tasks closed.
 */
export async function reconcileCloseTasks(supabase: AdminClient, periodEnd: string): Promise<number> {
  const { data: openRows, error: openError } = await supabase
    .from("balance_close_tasks")
    .select("id, chart_of_accounts_id")
    .eq("period_end", periodEnd)
    .eq("status", "open");
  if (openError) throw new Error(openError.message);

  const openTasks = (openRows ?? []) as { id: string; chart_of_accounts_id: string }[];
  if (openTasks.length === 0) return 0;

  const coaIds = openTasks.map((t) => t.chart_of_accounts_id);
  const { data: entryRows, error: entriesError } = await supabase
    .from("manual_entries")
    .select("chart_of_accounts_id")
    .eq("entry_kind", "balance")
    .eq("as_of_date", periodEnd)
    .in("chart_of_accounts_id", coaIds);
  if (entriesError) throw new Error(entriesError.message);

  const covered = new Set(((entryRows ?? []) as { chart_of_accounts_id: string }[]).map((r) => r.chart_of_accounts_id));
  const toClose = openTasks.filter((t) => covered.has(t.chart_of_accounts_id)).map((t) => t.id);
  if (toClose.length === 0) return 0;

  const { error: updateError } = await supabase
    .from("balance_close_tasks")
    .update({ status: "completed", completed_at: new Date().toISOString() })
    .in("id", toClose);
  if (updateError) throw new Error(updateError.message);

  return toClose.length;
}

/**
 * Pure. True when tasks EXIST and every one is completed or skipped.
 *
 * The empty case returns FALSE, deliberately, and `Array.every`'s vacuous truth
 * is exactly the trap. Nothing seeds a `manualBalance` source on a fresh
 * install, so `ensureTasksForPeriod` legitimately produces zero tasks -- and
 * with a vacuously-true reading the very first cron run froze the previous
 * month on day one, before its due date, permanently. "No tasks were generated"
 * is not the same statement as "all the work is done".
 *
 * A period with genuinely no manual accounts still freezes, via the caller's
 * past-due-date branch. That path is time-based and safe; this one is not.
 */
export function isPeriodClosed(tasks: CloseTask[]): boolean {
  if (tasks.length === 0) return false;
  return tasks.every((task) => task.status === "completed" || task.status === "skipped");
}

/**
 * The close due date for a period, derived from configuration ALONE.
 *
 * The cron previously read `tasks[0].dueDate`, which is unavailable in exactly
 * the situation that matters -- zero tasks -- leaving the freeze decision to
 * isPeriodClosed's vacuous truth. Deriving it here means the past-due branch
 * works whether or not any task exists.
 */
export function dueDateForPeriod(periodEnd: string, dueDay: number): string {
  return resolveDueDate(periodEnd, { monthOffset: 1, day: dueDay });
}

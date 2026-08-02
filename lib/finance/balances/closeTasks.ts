/**
 * Month-end close checklist for balance-sheet accounts that need a human to
 * supply a balance before a period is final: one balance_close_tasks row per
 * active account whose method reads a hand-entered figure and that lacks a
 * manual_entries balance row for that period_end.
 *
 * That set is every method with a `kind: "manual"` step -- see
 * requiresMonthEndBalance. It is not just manual entry: the Square balance
 * method derives its own movement but still needs a person to re-anchor it
 * every month, because the outflow half of that account is observable in no
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
 *
 * `skipTask` is the ONE other status write, and it is deliberately not a
 * shortcut to the same place: a skipped task records a REASON and never claims
 * a balance was entered. "This account held nothing this month and here is why"
 * is a real answer to the close; "mark it done" is not.
 */
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { resolveDueDate } from "@/lib/tax/dueDate";
import { addDaysIso } from "@/lib/tax/period";
// Side-effect registration, imported HERE rather than left to each caller.
//
// requiresMonthEndBalance asks the method registry rather than matching the
// name "manualBalance", which is the right question but means an unpopulated
// registry answers "nothing needs a human figure anywhere" -- and quietly
// creates zero close tasks rather than failing. The old hard-coded name could
// not go wrong that way, so this import is what replaces that safety. It pulls
// in the PROVIDER registry too (methods/index imports providers first), which
// requiresMonthEndBalance now reads.
import "./methods";
import {
  closeDueDaysOf,
  getMethod,
  requiresMonthEndBalance as methodRequiresMonthEndBalance,
  responsibleUserIdOf,
} from "./methods/registry";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

export type CloseTaskStatus = "open" | "completed" | "skipped";

export interface CloseTask {
  id: string;
  coaId: string;
  periodEnd: string;
  dueDate: string;
  status: CloseTaskStatus;
  alertSentAt: string | null;
  /** Why this account has no balance this month. Only ever set on a skip. */
  notes: string | null;
}

interface CloseTaskRow {
  id: string;
  chart_of_accounts_id: string;
  period_end: string;
  due_date: string;
  status: CloseTaskStatus;
  alert_sent_at: string | null;
  notes: string | null;
}

function toCloseTask(row: CloseTaskRow): CloseTask {
  return {
    id: row.id,
    coaId: row.chart_of_accounts_id,
    periodEnd: row.period_end,
    dueDate: row.due_date,
    status: row.status,
    alertSentAt: row.alert_sent_at,
    notes: row.notes,
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
 * Whether a selected source needs a person to supply a figure before the period
 * can be called closed.
 *
 * Asked entirely of the method declaration: a method needs a close task exactly
 * when one of its steps runs a provider that reads a hand-entered figure. This
 * used to be a `requiresCloseEntry` flag PLUS a hard-coded check for the
 * literal string "manualBalance" -- two extra ways of saying what the
 * declaration already says, and two more places to update when a method needs a
 * human figure. See requiresMonthEndBalance in methods/registry.ts for why the
 * derivation reads the steps rather than the setup fields.
 *
 * An unregistered key answers false rather than throwing: this runs first in
 * the close cron, and refusing to create ANY task because one source names
 * something unknown would be a worse failure than the unknown source itself.
 */
export function requiresMonthEndBalance(providerKey: string): boolean {
  const method = getMethod(providerKey);
  return method ? methodRequiresMonthEndBalance(method) : false;
}

/**
 * What an account's own setup says about its close: who is chasing it and how
 * long they have.
 *
 * Both answers live in `balance_sheet_account_sources.config` and are read
 * through the method declaration rather than by key, so this module never
 * learns a method's field names -- see responsibleUserIdOf and closeDueDaysOf.
 */
export interface CloseAssignment {
  coaId: string;
  responsibleUserId: string | null;
  /** Days after the month end, when this account overrides the global due day. */
  dueDaysAfterMonthEnd: number | null;
}

/**
 * Every active account that owes a hand-entered balance, with its assignment.
 *
 * Shared by ensureTasksForPeriod (which needs the due dates) and the alert path
 * (which needs the people), so the two cannot disagree about which accounts are
 * in scope.
 */
export async function listCloseAssignments(supabase: AdminClient): Promise<CloseAssignment[]> {
  const { data, error } = await supabase
    .from("balance_sheet_account_sources")
    .select("chart_of_accounts_id, provider_key, config")
    .eq("active", true);
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as { chart_of_accounts_id: string; provider_key: string; config: Record<string, unknown> | null }[];
  const out = new Map<string, CloseAssignment>();

  for (const row of rows) {
    const method = getMethod(row.provider_key);
    if (!method || !methodRequiresMonthEndBalance(method)) continue;
    const config = row.config ?? {};
    // An account with two qualifying sources is not a shape this table forbids,
    // so first-one-wins rather than last: re-running must give the same answer.
    if (out.has(row.chart_of_accounts_id)) continue;
    out.set(row.chart_of_accounts_id, {
      coaId: row.chart_of_accounts_id,
      responsibleUserId: responsibleUserIdOf(method, config),
      dueDaysAfterMonthEnd: closeDueDaysOf(config),
    });
  }

  return Array.from(out.values());
}

/**
 * Who to email about each account, by account id.
 *
 * An account is absent from the map when nobody has been named OR when the
 * person named no longer has a login -- the caller falls back to the admin
 * address for both, because an alert that goes nowhere is the one failure this
 * whole workflow exists to prevent. The Settings panel says the same thing
 * about a deleted user, so the gap is visible before it is discovered by a
 * month that quietly went unchased.
 */
export async function resolveResponsibleEmails(
  supabase: AdminClient,
  coaIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (coaIds.length === 0) return out;

  const wanted = new Set(coaIds);
  const assignments = (await listCloseAssignments(supabase)).filter(
    (a) => wanted.has(a.coaId) && a.responsibleUserId,
  );
  if (assignments.length === 0) return out;

  const { data, error } = await supabase
    .from("profiles")
    .select("id, email")
    .in("id", Array.from(new Set(assignments.map((a) => a.responsibleUserId as string))));
  if (error) throw new Error(error.message);

  const emailById = new Map(
    ((data ?? []) as { id: string; email: string | null }[])
      .filter((p): p is { id: string; email: string } => Boolean(p.email))
      .map((p) => [p.id, p.email]),
  );

  for (const a of assignments) {
    const email = emailById.get(a.responsibleUserId as string);
    if (email) out.set(a.coaId, email);
  }
  return out;
}

/**
 * Idempotently creates a balance_close_tasks row for every active account that
 * owes a hand-entered balance and has no manual_entries balance row for
 * `periodEnd` yet.
 *
 * Idempotency comes from upsert(..., { onConflict: "chart_of_accounts_id,
 * period_end", ignoreDuplicates: true }): a re-run leaves an existing task's
 * status untouched, and select("id") after an ignore-duplicates upsert returns
 * only the rows actually inserted. That is what makes it safe to call on demand
 * from the close screen as well as from the daily cron -- somebody landing
 * there from an alert must see the outstanding work whether or not a cron has
 * run since the account was configured.
 */
export async function ensureTasksForPeriod(supabase: AdminClient, periodEnd: string): Promise<number> {
  const assignments = await listCloseAssignments(supabase);
  const coaIds = assignments.map((a) => a.coaId);
  if (coaIds.length === 0) return 0;

  const { data: entryRows, error: entriesError } = await supabase
    .from("manual_entries")
    .select("chart_of_accounts_id")
    .eq("entry_kind", "balance")
    .eq("as_of_date", periodEnd)
    .in("chart_of_accounts_id", coaIds);
  if (entriesError) throw new Error(entriesError.message);

  const covered = new Set(((entryRows ?? []) as { chart_of_accounts_id: string }[]).map((r) => r.chart_of_accounts_id));
  const needing = assignments.filter((a) => !covered.has(a.coaId));
  if (needing.length === 0) return 0;

  const { dueDay } = await readCloseConfig(supabase);

  // Per account, not once for the period. The task row has always carried its
  // own due_date, so an account that genuinely takes longer -- one waiting on a
  // posted statement -- can say so without moving the deadline for everyone.
  // The period-level freeze decision still uses the single configured due day
  // (dueDateForPeriod), because a period has one deadline even when the
  // accounts inside it do not.
  const rows = needing.map((a) => ({
    chart_of_accounts_id: a.coaId,
    period_end: periodEnd,
    due_date: dueDateForAccount(periodEnd, dueDay, a.dueDaysAfterMonthEnd),
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
    .select("id, chart_of_accounts_id, period_end, due_date, status, alert_sent_at, notes")
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

/**
 * Pure. One account's own close deadline.
 *
 * Two different shapes of answer on purpose. The business-wide setting is a DAY
 * OF THE MONTH ("everything is due by the 5th"), which is how a close calendar
 * is normally written down and is what drives the period-level decision. An
 * account's override is a NUMBER OF DAYS AFTER the month end ("this one gets
 * ten days"), because an account-level allowance is a length of time, not a
 * date on someone else's calendar -- and a 31-day February would otherwise
 * silently give a shorter allowance than a 30-day April.
 */
export function dueDateForAccount(periodEnd: string, dueDay: number, daysAfterMonthEnd: number | null): string {
  return daysAfterMonthEnd === null
    ? dueDateForPeriod(periodEnd, dueDay)
    : addDaysIso(periodEnd, daysAfterMonthEnd);
}

/**
 * Records that an account genuinely has no balance this month, and why.
 *
 * The counterpart to reconcileCloseTasks, not a bypass of it. A completed task
 * asserts a figure exists and can be pointed at; a skipped one asserts the
 * opposite and is only meaningful WITH its reason, which is why an empty one is
 * refused here rather than left to the caller. `status = 'skipped'` and `notes`
 * have been in the schema since the table was created and had no writer until
 * now.
 *
 * Only an open task may be skipped: a completed one has a real balance behind
 * it, and letting a skip overwrite that would replace evidence with an excuse.
 */
export async function skipTask(supabase: AdminClient, taskId: string, reason: string): Promise<boolean> {
  const trimmed = reason.trim();
  if (trimmed === "") throw new Error("A skipped account needs a reason.");

  const { data, error } = await supabase
    .from("balance_close_tasks")
    .update({ status: "skipped", notes: trimmed })
    .eq("id", taskId)
    .eq("status", "open")
    .select("id");
  if (error) throw new Error(error.message);

  return (data ?? []).length > 0;
}

/**
 * Puts a skipped task back on the list.
 *
 * The reason is cleared rather than kept: `notes` reads as "why this month has
 * no balance", which stops being true the moment the account is outstanding
 * again. The change itself is not lost -- balance_close_tasks carries the
 * generic audit trigger.
 */
export async function reopenTask(supabase: AdminClient, taskId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("balance_close_tasks")
    .update({ status: "open", notes: null })
    .eq("id", taskId)
    .eq("status", "skipped")
    .select("id");
  if (error) throw new Error(error.message);

  return (data ?? []).length > 0;
}

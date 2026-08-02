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
 * successful balance-kind write so a task clears immediately). It reverses
 * itself too: delete that balance row and the task goes back on the list,
 * because a completed task that points at nothing is the one lie this
 * checklist cannot afford.
 *
 * Whether a PERIOD is closed is a separate question this module does not
 * answer -- see periodClose.ts. A finished checklist means the work is done;
 * only a person can say the books are final.
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

export interface ReconcileResult {
  /** Open tasks whose balance has now appeared. */
  completed: number;
  /** Completed tasks whose balance has since been deleted. */
  reopened: number;
}

/**
 * Makes each task agree with whether its account actually has a balance for
 * the period. The ONLY write path that ever marks a task completed -- see this
 * module's header -- and now the only one that takes it back.
 *
 * ── Why it has to run in both directions ─────────────────────────────────────
 * It only ever closed tasks. A balance entered by mistake and then deleted left
 * its task sitting at "completed" forever: nothing on the checklist, nothing in
 * the banner, no alert, and a period that would report itself ready to close
 * with an account behind it that has no figure at all. The task claimed a
 * balance existed and pointed at nothing -- which is the single claim this
 * whole checklist exists to make honestly.
 *
 * A SKIPPED task is deliberately left alone. It never asserted a balance; it
 * asserts there is none, with a reason, and that stays true whether or not a
 * row exists. Reopening it would erase the reason (see reopenTask) and
 * re-raise work somebody has already answered.
 */
export async function reconcileCloseTasks(supabase: AdminClient, periodEnd: string): Promise<ReconcileResult> {
  const { data: taskRows, error: tasksError } = await supabase
    .from("balance_close_tasks")
    .select("id, chart_of_accounts_id, status")
    .eq("period_end", periodEnd)
    .in("status", ["open", "completed"]);
  if (tasksError) throw new Error(tasksError.message);

  const tasks = (taskRows ?? []) as { id: string; chart_of_accounts_id: string; status: CloseTaskStatus }[];
  if (tasks.length === 0) return { completed: 0, reopened: 0 };

  const coaIds = tasks.map((t) => t.chart_of_accounts_id);
  const { data: entryRows, error: entriesError } = await supabase
    .from("manual_entries")
    .select("chart_of_accounts_id")
    .eq("entry_kind", "balance")
    .eq("as_of_date", periodEnd)
    .in("chart_of_accounts_id", coaIds);
  if (entriesError) throw new Error(entriesError.message);

  const covered = new Set(((entryRows ?? []) as { chart_of_accounts_id: string }[]).map((r) => r.chart_of_accounts_id));

  const toComplete = tasks.filter((t) => t.status === "open" && covered.has(t.chart_of_accounts_id)).map((t) => t.id);
  const toReopen = tasks.filter((t) => t.status === "completed" && !covered.has(t.chart_of_accounts_id)).map((t) => t.id);

  if (toComplete.length > 0) {
    const { error } = await supabase
      .from("balance_close_tasks")
      .update({ status: "completed", completed_at: new Date().toISOString() })
      .in("id", toComplete);
    if (error) throw new Error(error.message);
  }

  if (toReopen.length > 0) {
    // completed_at is cleared with the status, and alert_sent_at is NOT: the
    // account genuinely was chased for this period, and re-alerting somebody
    // who already had the email is how a real notice becomes noise. The
    // checklist and the banner both surface it immediately regardless.
    const { error } = await supabase
      .from("balance_close_tasks")
      .update({ status: "open", completed_at: null })
      .in("id", toReopen);
    if (error) throw new Error(error.message);
  }

  return { completed: toComplete.length, reopened: toReopen.length };
}

/**
 * Pure. True when no task is still open -- every account has either a balance
 * or a recorded reason it has none.
 *
 * ── The empty case returns TRUE now, and that used to be a bug ───────────────
 * This was `isPeriodClosed`, and its empty case returned FALSE on purpose:
 * `Array.every`'s vacuous truth was a trap while the CRON used this to decide
 * whether to freeze. Nothing seeds a manual source on a fresh install, so
 * `ensureTasksForPeriod` legitimately produces zero tasks, and a vacuously-true
 * reading froze the previous month on day one, permanently.
 *
 * The cron no longer freezes anything (see periodClose.ts), so nothing acts on
 * this answer unattended. Its only consumer is a readiness hint on a screen a
 * person is looking at, and there "nobody owes a balance this month" genuinely
 * is ready. The safety that mattered moved to where the decision moved: closing
 * requires a person, and a person is shown the coverage they are signing off.
 *
 * Renamed with it, because "is the period closed" is no longer a question the
 * task list can answer -- only `balance_period_closes` can.
 */
export function everyTaskAnswered(tasks: CloseTask[]): boolean {
  return tasks.every((task) => task.status === "completed" || task.status === "skipped");
}

/**
 * The close due date for a period, derived from configuration ALONE.
 *
 * Drives the alert lead time and the "the period is due the 5th" line on the
 * close screen. It is no longer a freeze trigger: a deadline passing says the
 * books are LATE, which is worth an email, and says nothing whatever about
 * whether they are finished.
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

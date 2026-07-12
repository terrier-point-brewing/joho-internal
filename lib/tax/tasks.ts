/**
 * Party-agnostic task orchestration: derives which filing periods need a
 * `tax_tasks` row, keeps that set in sync (idempotently) with the DB, and
 * answers "which open tasks need an alert today". The due-date rule itself
 * is owned by each party template (`TaxPartyTemplate.computePeriod`) — this
 * module never hardcodes a due-date formula.
 *
 * Pure, DB-free: `dueDateFor`, `periodsNeedingTasks`, `isAlertEligible`.
 * DB wrappers (thin, take an injected `SupabaseClient` as the first arg so
 * they're testable with a stub, same convention as
 * lib/tax/backfillLineItemTaxes.ts): everything else.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Frequency, TaxPartyTemplate, TaxPeriod, TaxSchedule, TaxTask, TaxTaskStatus, WorksheetData } from "./types";
import { addDaysIso } from "./period";
import { getParty } from "./registry";

// Default catch-up window for `ensureTasksForSchedule` when the caller (a
// cron route, most likely) doesn't pass one explicitly. Wide enough to cover
// a full annual period; safe to over-include because the upsert onConflict
// makes re-creation a no-op.
const DEFAULT_LOOKBACK_DAYS = 400;

function isoOfUtcDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Parses a YYYY-MM-DD string into a Date anchored at UTC noon — same
// convention period.ts uses internally so a period-end string can be handed
// straight back into `party.computePeriod(freq, ref)`.
function isoToUtcNoonDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}

/**
 * The due date for the period ending on `periodEnd`, per the party's own
 * due-date rule. Delegates entirely to `party.computePeriod` — this
 * function just re-anchors `periodEnd` as a `ref` Date within that period
 * (periodEnd is always the period's last day, so it's guaranteed to fall
 * inside the period it names).
 */
export function dueDateFor(party: TaxPartyTemplate, freq: Frequency, periodEnd: string): string {
  return party.computePeriod(freq, isoToUtcNoonDate(periodEnd)).due;
}

/**
 * Distinct periods, for `freq`, whose end date is strictly before `today`
 * and falls within the trailing `lookbackDays` window — i.e. periods that
 * have concluded and are due (or overdue) for a task, excluding the
 * in-progress period `today` currently sits in.
 *
 * Walks backward from `today`, jumping a full period at a time (via each
 * period's `start`) rather than day-by-day, so this stays cheap even for a
 * large lookback window.
 */
export function periodsNeedingTasks(
  freq: Frequency,
  today: Date,
  lookbackDays: number,
  party: TaxPartyTemplate,
): TaxPeriod[] {
  const todayIso = isoOfUtcDate(today);
  const windowStartIso = addDaysIso(todayIso, -lookbackDays);
  const periods: TaxPeriod[] = [];

  let cursorIso = addDaysIso(todayIso, -1);
  while (cursorIso >= windowStartIso) {
    const period = party.computePeriod(freq, isoToUtcNoonDate(cursorIso));
    if (period.end < todayIso) {
      periods.push(period);
    }
    const prevCursor = addDaysIso(period.start, -1);
    if (prevCursor >= cursorIso) break; // defensive: computePeriod must move backward
    cursorIso = prevCursor;
  }

  return periods.reverse(); // chronological ascending (oldest period first)
}

/** Pure eligibility predicate: is `todayIso` on/after `dueDate - leadDays`? */
export function isAlertEligible(todayIso: string, dueDate: string, leadDays: number): boolean {
  return todayIso >= addDaysIso(dueDate, -leadDays);
}

/**
 * Idempotently creates a `tax_tasks` row for every period the schedule's
 * party/frequency says needs one (per `periodsNeedingTasks`). Idempotency
 * comes from `upsert(..., { onConflict: "schedule_id,period_end",
 * ignoreDuplicates: true })`: an existing row for the same
 * (schedule_id, period_end) is left untouched (so in-progress worksheet
 * edits / status are never clobbered by a re-run), and `select("id")` after
 * an ignore-duplicates upsert returns only the rows actually inserted.
 */
export async function ensureTasksForSchedule(
  sb: SupabaseClient,
  schedule: TaxSchedule,
  today: Date = new Date(),
  lookbackDays: number = DEFAULT_LOOKBACK_DAYS,
): Promise<{ created: number }> {
  const party = getParty(schedule.party_key);
  const periods = periodsNeedingTasks(schedule.frequency, today, lookbackDays, party);
  if (periods.length === 0) return { created: 0 };

  const rows = periods.map((p) => ({
    schedule_id: schedule.id,
    party_key: schedule.party_key,
    period_start: p.start,
    period_end: p.end,
    due_date: p.due,
  }));

  const { data, error } = await sb
    .from("tax_tasks")
    .upsert(rows, { onConflict: "schedule_id,period_end", ignoreDuplicates: true })
    .select("id");
  if (error) throw new Error(error.message);

  return { created: (data ?? []).length };
}

interface AlertCandidateRow {
  id: string;
  schedule_id: string;
  party_key: string;
  period_start: string;
  period_end: string;
  due_date: string;
  status: TaxTaskStatus;
  alert_sent_at: string | null;
  worksheet: WorksheetData | null;
  confirmation_number: string | null;
  amount_paid_cents: number | null;
  submitted_on: string | null;
  notes: string | null;
  completed_at: string | null;
  completed_by: string | null;
  created_at: string;
  updated_at: string;
  tax_schedules: { lead_days: number } | null;
}

/**
 * Open tasks (`status = 'open'`, `alert_sent_at is null`) whose per-schedule
 * `lead_days` puts `today` at or past the alert threshold. `lead_days` lives
 * on `tax_schedules`, not `tax_tasks`, so this pulls it via an embedded
 * select and applies the pure `isAlertEligible` predicate client-side.
 */
export async function tasksNeedingAlert(sb: SupabaseClient, today: Date): Promise<TaxTask[]> {
  const { data, error } = await sb
    .from("tax_tasks")
    .select("*, tax_schedules(lead_days)")
    .eq("status", "open")
    .is("alert_sent_at", null);
  if (error) throw new Error(error.message);

  const todayIso = isoOfUtcDate(today);
  const rows = (data ?? []) as AlertCandidateRow[];
  const eligible = rows.filter((row) => isAlertEligible(todayIso, row.due_date, row.tax_schedules?.lead_days ?? 0));
  return eligible.map((row): TaxTask => ({
    id: row.id,
    schedule_id: row.schedule_id,
    party_key: row.party_key,
    period_start: row.period_start,
    period_end: row.period_end,
    due_date: row.due_date,
    status: row.status,
    alert_sent_at: row.alert_sent_at,
    worksheet: row.worksheet,
    confirmation_number: row.confirmation_number,
    amount_paid_cents: row.amount_paid_cents,
    submitted_on: row.submitted_on,
    notes: row.notes,
    completed_at: row.completed_at,
    completed_by: row.completed_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

export async function markAlerted(sb: SupabaseClient, taskId: string): Promise<void> {
  const nowIso = new Date().toISOString();
  const { error } = await sb
    .from("tax_tasks")
    .update({ alert_sent_at: nowIso, updated_at: nowIso })
    .eq("id", taskId);
  if (error) throw new Error(error.message);
}

export async function getTask(sb: SupabaseClient, id: string): Promise<TaxTask | null> {
  const { data, error } = await sb.from("tax_tasks").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as TaxTask | null) ?? null;
}

export interface ListTasksFilter {
  partyKey?: string;
  status?: TaxTaskStatus;
  scheduleId?: string;
}

export async function listTasks(sb: SupabaseClient, filter: ListTasksFilter = {}): Promise<TaxTask[]> {
  let query = sb.from("tax_tasks").select("*").order("due_date", { ascending: true });
  if (filter.status) query = query.eq("status", filter.status);
  if (filter.partyKey) query = query.eq("party_key", filter.partyKey);
  if (filter.scheduleId) query = query.eq("schedule_id", filter.scheduleId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as TaxTask[];
}

export async function saveWorksheet(sb: SupabaseClient, id: string, worksheet: WorksheetData): Promise<TaxTask> {
  const { data, error } = await sb
    .from("tax_tasks")
    .update({ worksheet, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data as TaxTask;
}

export interface CompleteTaskInput {
  confirmation_number: string | null;
  amount_paid_cents: number | null;
  submitted_on: string | null;
  notes: string | null;
  userId: string;
}

export async function completeTask(sb: SupabaseClient, id: string, input: CompleteTaskInput): Promise<TaxTask> {
  const nowIso = new Date().toISOString();
  const { data, error } = await sb
    .from("tax_tasks")
    .update({
      status: "completed",
      confirmation_number: input.confirmation_number,
      amount_paid_cents: input.amount_paid_cents,
      submitted_on: input.submitted_on,
      notes: input.notes,
      completed_at: nowIso,
      completed_by: input.userId,
      updated_at: nowIso,
    })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data as TaxTask;
}

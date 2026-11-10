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
import { readDueRule, resolveDueDate } from "./dueDate";
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
 *
 * `startBoundaryIso` (optional) is the schedule's own start: any period that
 * ended before it is dropped, so a schedule can never manufacture filing
 * obligations for periods predating it. See `scheduleStartBoundary`.
 */
export function periodsNeedingTasks(
  freq: Frequency,
  today: Date,
  lookbackDays: number,
  party: TaxPartyTemplate,
  startBoundaryIso?: string,
): TaxPeriod[] {
  const todayIso = isoOfUtcDate(today);
  const windowStartIso = addDaysIso(todayIso, -lookbackDays);
  const periods: TaxPeriod[] = [];

  let cursorIso = addDaysIso(todayIso, -1);
  while (cursorIso >= windowStartIso) {
    const period = party.computePeriod(freq, isoToUtcNoonDate(cursorIso));
    if (period.end < todayIso && (!startBoundaryIso || period.end >= startBoundaryIso)) {
      periods.push(period);
    }
    const prevCursor = addDaysIso(period.start, -1);
    if (prevCursor >= cursorIso) break; // defensive: computePeriod must move backward
    cursorIso = prevCursor;
  }

  return periods.reverse(); // chronological ascending (oldest period first)
}

/**
 * The date before which a schedule must never generate tasks.
 *
 * Explicit wins: `config.first_period_start` (a YYYY-MM-DD string) is the
 * operator's declaration of the first period this schedule is responsible
 * for — the TTB quarterly beer excise schedule starts at Q3 2026 because the
 * brewery says so, not because of when the row happened to be created.
 * Unset, it falls back to the schedule's `created_at` date, which leaves
 * every pre-existing schedule generating exactly what it generated before
 * (their periods all post-date their own creation) while stopping any new
 * schedule from inventing overdue filings for history it never covered.
 */
export function scheduleStartBoundary(schedule: TaxSchedule): string | undefined {
  const declared = schedule.config?.first_period_start;
  if (typeof declared === "string" && /^\d{4}-\d{2}-\d{2}$/.test(declared)) return declared;
  const createdAt = schedule.created_at;
  return typeof createdAt === "string" && createdAt.length >= 10 ? createdAt.slice(0, 10) : undefined;
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
  const party = getParty(schedule.filing_key);
  const periods = periodsNeedingTasks(
    schedule.frequency,
    today,
    lookbackDays,
    party,
    scheduleStartBoundary(schedule),
  );
  if (periods.length === 0) return { created: 0 };

  const rule = readDueRule(schedule.config) ?? party.defaultDueRule(schedule.frequency);

  const rows = periods.map((p) => ({
    schedule_id: schedule.id,
    filing_key: schedule.filing_key,
    period_start: p.start,
    period_end: p.end,
    due_date: resolveDueDate(p.end, rule),
  }));

  const { data, error } = await sb
    .from("tax_tasks")
    .upsert(rows, { onConflict: "schedule_id,period_end", ignoreDuplicates: true })
    .select("id");
  if (error) throw new Error(error.message);

  return { created: (data ?? []).length };
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
  if (filter.partyKey) query = query.eq("filing_key", filter.partyKey);
  if (filter.scheduleId) query = query.eq("schedule_id", filter.scheduleId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as TaxTask[];
}

export async function saveWorksheet(sb: SupabaseClient, id: string, worksheet: WorksheetData): Promise<TaxTask> {
  const { data, error } = await sb
    .from("tax_tasks")
    .update({ worksheet })
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
    })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data as TaxTask;
}

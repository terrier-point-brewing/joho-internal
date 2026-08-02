/**
 * Closing a balance-sheet period, as something a person does.
 *
 * ── The distinction this module exists to make ───────────────────────────────
 * The nightly cron used to freeze a period once every close task was done OR
 * its due date had passed. The second half turns "the deadline went by" into
 * "these books are final", and only the first of those is decidable by
 * software. June 2026 is what that produced: frozen, therefore final, with 6
 * accounts carrying a balance and 39 with no source at all. Nobody closed June;
 * the 5th of July happened.
 *
 * So the cron now snapshots, raises tasks, reconciles and alerts, and never
 * freezes. `gl_account_balances.is_frozen` is written HERE and nowhere else,
 * and means exactly one thing: a named person asserted these books are final.
 *
 * ── An open month keeps recomputing, on purpose ──────────────────────────────
 * The time-based freeze was reaching for a real problem -- a late July expense
 * would otherwise change July's balance in October. But that is only a problem
 * once someone has CLAIMED July is done, and once they have, the period is
 * frozen by that claim. Before it, recomputing is not a bug; it is the month
 * still being open. There is deliberately no long-stop auto-freeze anywhere.
 *
 * ── What a close refuses, and why refusing is not the same as nagging ────────
 * Two things block a close, and both are things software genuinely knows:
 *
 *   1. An account still owes a hand-entered balance. Not "we would prefer one"
 *      -- the close checklist has a skip that records a reason, so "this
 *      account had nothing this month" is already sayable. An OPEN task means
 *      nobody has said anything at all about that account.
 *   2. The recalculation did not finish cleanly. A provider that threw leaves
 *      its account written from an earlier run or not written at all (see
 *      snapshot.ts's per-account failure rule), so freezing on top of it would
 *      preserve a figure nobody computed for this month.
 *
 * Neither has an override. A stuck provider is fixed by fixing the source, and
 * a "close anyway" button is how June 2026 would happen again with a name
 * attached to it.
 *
 * Accounts with NO source at all do not block. There are always some, and
 * blocking on them would mean no month is ever closable. They are reported to
 * the person closing instead, because "45 accounts, 6 of them sourced" is
 * exactly what they are putting their name to.
 *
 * ── Reopen ───────────────────────────────────────────────────────────────────
 * The symmetric, attributed inverse: unfreeze the period so it recomputes, and
 * record who did it and why. The reason is mandatory for the same reason a
 * skipped task's is -- reversing a formal assertion without saying why is
 * indistinguishable from never having meant it.
 *
 * Backed by 20260918090000_period_close_is_a_human_act.sql.
 */
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
// Side-effect registration, for the same reason closeTasks.ts does it: this
// module runs snapshotPeriod, and an unpopulated registry would resolve every
// source to "unknown provider" and block every close with a nonsense reason.
import "./methods";
import { snapshotPeriod, freezePeriod, unfreezePeriod, type SnapshotResult } from "./snapshot";
import { ensureTasksForPeriod, listTasksForPeriod, reconcileCloseTasks } from "./closeTasks";
import { formatPeriodLabel } from "./periods";
import { monthEnd } from "@/lib/finance/manualEntries";
import { readPeriodClose as readState, toState, type CloseEventRow, type PeriodCloseAction, type PeriodCloseState } from "./periodCloseState";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

// The read side lives one level down so snapshot.ts can refuse to recompute a
// closed month without importing this module back. Re-exported so nothing else
// has to know about the split.
export { readPeriodClose } from "./periodCloseState";
export type { PeriodCloseState, PeriodCloseAction } from "./periodCloseState";

/**
 * Pure. Every reason this period cannot be closed right now, in plain English.
 *
 * Empty means closable. The sentences are shown to a bookkeeper verbatim, so
 * they name accounts and say what to do rather than reporting a condition.
 */
export function describeCloseBlockers(input: {
  periodEnd: string;
  todayIso: string;
  alreadyClosed: boolean;
  /** Account labels ("1010 · Cash on Hand") with an open close task. */
  outstandingAccounts: string[];
  /** snapshotPeriod's own errors from the recalculation just run. */
  snapshotErrors: string[];
}): string[] {
  const label = formatPeriodLabel(input.periodEnd);
  const blockers: string[] = [];

  if (input.alreadyClosed) {
    blockers.push(`${label} is already closed.`);
    // Nothing else is worth saying about a closed period, and the outstanding
    // list would be stale anyway -- it stopped being maintained at the close.
    return blockers;
  }

  if (input.periodEnd > input.todayIso) {
    blockers.push(`${label} has not ended yet, so there is nothing final to record.`);
    return blockers;
  }

  if (input.outstandingAccounts.length > 0) {
    const n = input.outstandingAccounts.length;
    blockers.push(
      `${n} account${n === 1 ? "" : "s"} still ${n === 1 ? "has" : "have"} no answer for ${label}: ` +
        `${input.outstandingAccounts.join(", ")}. Enter a balance, or record why there is none.`,
    );
  }

  if (input.snapshotErrors.length > 0) {
    blockers.push(
      `The recalculation of ${label} did not finish cleanly, so some accounts are missing or out of date: ` +
        `${input.snapshotErrors.join("; ")}.`,
    );
  }

  return blockers;
}

export interface ClosePeriodResult {
  /** True when the period is now closed. False means nothing was written at all. */
  ok: boolean;
  /** Empty when ok. Otherwise every reason, in plain English. */
  blockers: string[];
  /** The recalculation this close ran, or null when it was refused before running one. */
  snapshot: SnapshotResult | null;
  /** The recorded close, when one happened. */
  state: PeriodCloseState | null;
}

/**
 * Recalculate the period, check it is genuinely finished, then freeze it with
 * the closer's name on it.
 *
 * The recalculation is run HERE rather than trusted from last night's cron run
 * on purpose: a close freezes whatever figures are stored, so the figures being
 * frozen should be the ones just computed. Reading yesterday's cron_runs detail
 * instead would freeze a snapshot taken before this morning's manual entries.
 *
 * The checklist is refreshed first for the mirror-image reason: a task raised
 * only by the nightly cron would let an account configured this morning be
 * closed over without anyone being asked for its balance.
 *
 * Nothing is written unless every blocker clears -- a refused close leaves the
 * period exactly as it found it, apart from the recalculation, which is the
 * ordinary open-month behaviour anyway.
 */
export async function closePeriod(
  supabase: AdminClient,
  input: { periodEnd: string; actorId: string; todayIso: string; reason?: string | null },
): Promise<ClosePeriodResult> {
  const { periodEnd, actorId, todayIso } = input;

  const existing = await readState(supabase, periodEnd);
  const alreadyClosed = existing?.closed ?? false;

  // Both cheap refusals happen before any recalculation, which for a month with
  // live integrations means a round of real API calls: a closed month is
  // refused by snapshotPeriod anyway, and a month that has not ended is a
  // question nobody asked.
  const earlyBlockers = describeCloseBlockers({
    periodEnd,
    todayIso,
    alreadyClosed,
    outstandingAccounts: [],
    snapshotErrors: [],
  });
  if (earlyBlockers.length > 0) {
    return { ok: false, blockers: earlyBlockers, snapshot: null, state: existing };
  }

  await ensureTasksForPeriod(supabase, periodEnd);
  await reconcileCloseTasks(supabase, periodEnd);

  const snapshot = await snapshotPeriod(supabase, periodEnd, { todayIso });
  const tasks = await listTasksForPeriod(supabase, periodEnd);
  const outstanding = tasks.filter((t) => t.status === "open");

  const blockers = describeCloseBlockers({
    periodEnd,
    todayIso,
    alreadyClosed: false,
    outstandingAccounts: await labelAccounts(supabase, outstanding.map((t) => t.coaId)),
    snapshotErrors: snapshot.errors,
  });
  if (blockers.length > 0) {
    return { ok: false, blockers, snapshot, state: existing };
  }

  // Record first, freeze second, and the order is load-bearing.
  //
  // The record is what stops recomputation -- snapshotPeriod refuses a period
  // recorded as closed outright -- so a failure between the two steps leaves a
  // month that is genuinely closed and merely missing its belt-and-braces flag,
  // which the next close or the next snapshot resolves. The other order fails
  // the opposite way: frozen rows with nobody's name on them, and reopenPeriod
  // refusing to help because as far as it can see the month was never closed.
  // That is precisely the state June 2026 is in.
  const state = await recordCloseEvent(supabase, {
    periodEnd,
    action: "closed",
    actorId,
    reason: input.reason?.trim() || null,
  });
  await freezePeriod(supabase, periodEnd);

  return { ok: true, blockers: [], snapshot, state };
}

/**
 * The attributed inverse. Unfreezes the period so it recomputes from the next
 * snapshot run, and records who took it back and why.
 *
 * Returns null when the period was not closed to begin with, which the route
 * turns into a 409 rather than a silent success -- "reopen" against an open
 * month is a sign the screen and the database disagree, not a no-op worth
 * hiding.
 */
export async function reopenPeriod(
  supabase: AdminClient,
  input: { periodEnd: string; actorId: string; reason: string },
): Promise<PeriodCloseState | null> {
  const reason = input.reason.trim();
  if (reason === "") throw new Error("Say why this month is being reopened.");

  const existing = await readState(supabase, input.periodEnd);
  if (!existing?.closed) return null;

  // Mirror image of the close ordering: unfreeze first, then record. A failure
  // in between leaves the month unfrozen but still recorded as closed, so
  // snapshotPeriod keeps refusing it -- nothing recomputes behind somebody's
  // back, and pressing Reopen again finishes the job.
  await unfreezePeriod(supabase, input.periodEnd);
  return recordCloseEvent(supabase, {
    periodEnd: input.periodEnd,
    action: "reopened",
    actorId: input.actorId,
    reason,
  });
}

async function recordCloseEvent(
  supabase: AdminClient,
  row: { periodEnd: string; action: PeriodCloseAction; actorId: string; reason: string | null },
): Promise<PeriodCloseState> {
  const { data, error } = await supabase
    .from("balance_period_closes")
    .insert({
      period_end: row.periodEnd,
      action: row.action,
      actor_id: row.actorId,
      reason: row.reason,
    })
    .select("period_end, action, actor_id, reason, created_at")
    .single();
  if (error) throw new Error(error.message);

  return toState(supabase, data as CloseEventRow);
}

/** "1010 · Cash on Hand" per account, for sentences a bookkeeper reads. */
async function labelAccounts(supabase: AdminClient, coaIds: string[]): Promise<string[]> {
  if (coaIds.length === 0) return [];

  const { data, error } = await supabase
    .from("chart_of_accounts")
    .select("id, account_name, account_number")
    .in("id", Array.from(new Set(coaIds)));
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as { id: string; account_name: string; account_number: string | null }[];
  const byId = new Map(rows.map((r) => [r.id, r.account_number ? `${r.account_number} · ${r.account_name}` : r.account_name]));
  return coaIds.map((id) => byId.get(id) ?? "an account that no longer exists");
}

/**
 * Refuses a write into a month somebody has closed, in words.
 *
 * Returns null when the month is open (the normal case) and a sentence when it
 * is not. This is the guardrail §6 of the handoff folds into the close: entering
 * a balance for a closed period used to succeed and change nothing. The
 * manual_entries row was written, the snapshot skipped the frozen
 * gl_account_balances row, and the balance sheet went on showing the old figure
 * with no error anywhere. Somebody correcting a number would watch it save and
 * then not move.
 *
 * Refusing needs the close workflow to exist, which is why it lands here rather
 * than as its own patch: "you cannot edit June" is only a reasonable thing to
 * say once "reopen June" is a button somebody can press.
 */
export async function closedPeriodRefusal(supabase: AdminClient, asOfDate: string): Promise<string | null> {
  const periodEnd = monthEnd(asOfDate);
  const state = await readState(supabase, periodEnd);
  if (!state?.closed) return null;

  return (
    `${formatPeriodLabel(periodEnd)} is closed, so its figures no longer change. ` +
    `Reopen the month on the close checklist first, then enter this.`
  );
}

/**
 * What the person closing is actually putting their name to.
 *
 * Not a blocker and not a warning -- a statement of coverage. An account with a
 * source that produced nothing this month is the interesting case: it is
 * configured, so somebody expected a figure, and none arrived. Accounts with no
 * source at all are counted but not listed; that backlog belongs to the
 * unsourced-accounts tile on the balance sheet, not to one month's close.
 */
export interface PeriodCoverage {
  /** Accounts with an active source declared. */
  configured: number;
  /** Of those, how many produced a stored balance for this period. */
  withBalance: number;
  /** Labels of configured accounts that produced nothing. */
  missing: string[];
}

export async function readPeriodCoverage(supabase: AdminClient, periodEnd: string): Promise<PeriodCoverage> {
  const [sourcesRes, balancesRes] = await Promise.all([
    supabase.from("balance_sheet_account_sources").select("chart_of_accounts_id").eq("active", true),
    supabase.from("gl_account_balances").select("chart_of_accounts_id").eq("period_end", periodEnd),
  ]);
  if (sourcesRes.error) throw new Error(sourcesRes.error.message);
  if (balancesRes.error) throw new Error(balancesRes.error.message);

  const configured = new Set(
    ((sourcesRes.data ?? []) as { chart_of_accounts_id: string }[]).map((r) => r.chart_of_accounts_id),
  );
  const withBalance = new Set(
    ((balancesRes.data ?? []) as { chart_of_accounts_id: string }[]).map((r) => r.chart_of_accounts_id),
  );

  const missingIds = Array.from(configured).filter((id) => !withBalance.has(id));

  return {
    configured: configured.size,
    withBalance: Array.from(configured).filter((id) => withBalance.has(id)).length,
    missing: await labelAccounts(supabase, missingIds),
  };
}

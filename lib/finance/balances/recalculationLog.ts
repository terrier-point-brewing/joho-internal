/**
 * The record of each recalculation of a period, and how it went.
 *
 * A close reruns the recalculation and refuses if any account fails
 * (periodClose.ts). Until this existed the only way to learn that a step was
 * failing was to press Close or Preview and read the refusal: October 2026's
 * gift card step timed out on 8 nights in 22 and the close page never said so.
 *
 * ── Three things write here, and they all count ──────────────────────────────
 *   - the nightly job, for every month still open;
 *   - "Check again" on the close page (a dry run);
 *   - the close itself, whether or not it went through.
 *
 * The second and third are why this is a log and not a read of last night's
 * cron row. The first version of the page read only the nightly run, so after
 * a fix it kept saying "failing" until the next morning, and a clean "Check
 * again" was forgotten on reload. A check a person ran a minute ago is newer
 * evidence than a job that ran at 4am, and has to be allowed to win.
 *
 * ── Where it is kept ─────────────────────────────────────────────────────────
 * In `cron_runs`, under its own job name. That table is already the audit trail
 * for unattended work and already records who triggered a run and when. The
 * job name is deliberately NOT `balance-close`: these rows are per period and
 * some are dry runs, and the Cron Jobs monitor's "last run of balance-close"
 * must go on meaning the nightly job.
 *
 * The nightly job's own `balance-close` row still carries the latest month's
 * result in `detail.snapshot`, and is read too, so history from before this
 * module is not lost.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const RECALCULATION_JOB = "balance-close-check";
const NIGHTLY_JOB = "balance-close";

export interface Recalculation {
  /** When the recalculation started. */
  at: string;
  /** Who or what ran it. */
  trigger: "schedule" | "manual";
  /** One plain sentence per account that failed. Empty when clean. */
  errors: string[];
  /** The same failures exactly as the provider reported them, for whoever has to fix one. */
  rawErrors: string[];
  /** The balancing difference that run arrived at. Null when it could not say. */
  balancingDifferenceCents: number | null;
}

interface RunRow {
  job: string;
  status: string;
  error: string | null;
  started_at: string;
  triggered_by: string | null;
  detail: {
    periodEnd?: string;
    errors?: string[];
    balancingDifferenceCents?: number | null;
    snapshot?: { errors?: string[]; balancingDifferenceCents?: number | null };
  } | null;
}

/**
 * Pure. One provider error as a sentence a bookkeeper can read.
 *
 * Providers report `Method "giftCardLiability" step "giftCardsRedeemed" failed:
 * canceling statement due to statement timeout (account <uuid>)`. All of it is
 * accurate and none of it says which line of the balance sheet is affected.
 * The account is named, the commonest cause is put in words, and anything not
 * recognised is passed through rather than guessed at.
 */
export function plainRecalculationError(raw: string, accountLabelById: Map<string, string>): string {
  const account = raw.match(/\(account ([0-9a-f-]{36})\)\s*$/i);
  const label = account ? accountLabelById.get(account[1]) ?? null : null;
  const body = account ? raw.slice(0, account.index).trim() : raw.trim();
  const why = body.includes("failed:") ? body.slice(body.indexOf("failed:") + "failed:".length).trim() : body;

  const cause = /statement timeout|timed out|timeout/i.test(why)
    ? "the database took too long to answer (a timeout)"
    : why.replace(/\.$/, "");

  return label ? `${label} could not be recalculated: ${cause}.` : `An account could not be recalculated: ${cause}.`;
}

function accountIdsIn(errors: string[]): string[] {
  const ids = new Set<string>();
  for (const e of errors) {
    const m = e.match(/\(account ([0-9a-f-]{36})\)\s*$/i);
    if (m) ids.add(m[1]);
  }
  return Array.from(ids);
}

function toRun(row: RunRow): { at: string; trigger: "schedule" | "manual"; rawErrors: string[]; balancingDifferenceCents: number | null } {
  if (row.status !== "success") {
    return {
      at: row.started_at,
      trigger: row.triggered_by === "manual" ? "manual" : "schedule",
      rawErrors: [row.error ?? "The recalculation did not finish."],
      balancingDifferenceCents: null,
    };
  }
  const own = row.job === RECALCULATION_JOB;
  return {
    at: row.started_at,
    trigger: row.triggered_by === "manual" ? "manual" : "schedule",
    rawErrors: (own ? row.detail?.errors : row.detail?.snapshot?.errors) ?? [],
    balancingDifferenceCents: (own ? row.detail?.balancingDifferenceCents : row.detail?.snapshot?.balancingDifferenceCents) ?? null,
  };
}

/**
 * The period's most recent recalculations, newest first.
 *
 * A nightly run that crashed outright has no `detail`, so no period to match
 * on. It is left out here: the Cron Jobs monitor and its own alert already
 * report a failed job, and attributing it to one month would be a guess.
 */
export async function readRecentRecalculations(supabase: SupabaseClient, periodEnd: string, limit: number): Promise<Recalculation[]> {
  const { data, error } = await supabase
    .from("cron_runs")
    .select("job, status, error, started_at, triggered_by, detail")
    .in("job", [RECALCULATION_JOB, NIGHTLY_JOB])
    .eq("detail->>periodEnd", periodEnd)
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);

  const runs = ((data ?? []) as RunRow[]).map(toRun);
  const ids = accountIdsIn(runs.flatMap((r) => r.rawErrors));
  const labels = new Map<string, string>();
  if (ids.length > 0) {
    const { data: accounts, error: coaError } = await supabase
      .from("chart_of_accounts")
      .select("id, account_number, account_name")
      .in("id", ids);
    if (coaError) throw new Error(coaError.message);
    for (const a of (accounts ?? []) as { id: string; account_number: string | null; account_name: string }[]) {
      labels.set(a.id, a.account_number ? `${a.account_number} ${a.account_name}` : a.account_name);
    }
  }

  return runs.map((r) => ({ ...r, errors: r.rawErrors.map((e) => plainRecalculationError(e, labels)) }));
}

/** The most recent one, or null when the period has never been recalculated on record. */
export async function readLastRecalculation(supabase: SupabaseClient, periodEnd: string): Promise<Recalculation | null> {
  return (await readRecentRecalculations(supabase, periodEnd, 1))[0] ?? null;
}

/**
 * Record one recalculation. Best-effort by design: this is evidence about a
 * recalculation, and failing to write it must never fail the recalculation, a
 * preview, or a close that has already gone through.
 */
export async function recordRecalculation(
  supabase: SupabaseClient,
  input: {
    periodEnd: string;
    errors: string[];
    balancingDifferenceCents: number | null;
    trigger: "schedule" | "manual";
    actorId?: string | null;
    startedAt: Date;
    /** What ran it, for whoever reads the log: "nightly", "check" or "close". */
    source: "nightly" | "check" | "close";
  },
): Promise<void> {
  try {
    const { error } = await supabase.from("cron_runs").insert({
      job: RECALCULATION_JOB,
      status: "success",
      started_at: input.startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - input.startedAt.getTime(),
      triggered_by: input.trigger,
      triggered_by_user_id: input.actorId ?? null,
      detail: {
        periodEnd: input.periodEnd,
        source: input.source,
        errors: input.errors,
        balancingDifferenceCents: input.balancingDifferenceCents,
      },
    });
    if (error) console.error("[recalculation-log] could not record", { periodEnd: input.periodEnd, error: error.message });
  } catch (err) {
    console.error("[recalculation-log] could not record", { periodEnd: input.periodEnd, err });
  }
}

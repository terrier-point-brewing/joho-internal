/**
 * Wraps a job's work: claims the run lock, times it, runs it, and records one
 * cron_runs row (success or error) so the Settings → Cron Jobs monitor can show
 * history.
 *
 * Every job goes through here whichever way it was started — the nightly
 * schedule and the "Run now" button are two callers of one runner, so a manual
 * run is guarded, timed and recorded exactly like a scheduled one.
 *
 * Logging is best-effort — a failed insert (e.g. before a migration is applied)
 * never fails the job itself. The caller stays in control of the HTTP response.
 */
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export type CronTrigger = "schedule" | "manual";

export type CronOutcome =
  | { ok: true;  detail: unknown }
  /** Another run of the same job already holds the lock; nothing was done. */
  | { ok: false; busy: true;  error: string }
  | { ok: false; busy: false; error: string };

export interface RunCronJobOptions {
  /** How the run was started. Defaults to the schedule, which is the common case. */
  trigger?: CronTrigger;
  /** Who pressed the button, on a manual run. Null for a scheduled one. */
  actorId?: string | null;
  /**
   * Ceiling on how long a crashed run can keep the next one out. The lease is
   * released in a finally, so this only matters when the process dies outright.
   */
  lockTtlSeconds?: number;
}

/**
 * Generous by default: the slowest jobs here page against a bank or against
 * Square for minutes at a time, and a lease that expires under a still-running
 * job is worse than one that lingers after a crash.
 */
const DEFAULT_LOCK_TTL_SECONDS = 900;

/**
 * Namespaced so a run's lease can never collide with a lock some other part of
 * the system claims under a bare name — the taproom sync already holds one of
 * its own, at a finer grain than a whole run.
 */
function lockKey(job: string): string {
  return `cron:${job}`;
}

/** Shown to whoever pressed the button, so it has to read as a sentence. */
export const BUSY_MESSAGE =
  "This job is already running. Wait for the run in progress to finish, then start it again.";

export async function runCronJob(
  job: string,
  work: () => Promise<unknown>,
  options: RunCronJobOptions = {},
): Promise<CronOutcome> {
  const startedAt = new Date();
  const supabase  = createSupabaseAdminClient();
  const trigger   = options.trigger ?? "schedule";
  const ttl       = options.lockTtlSeconds ?? DEFAULT_LOCK_TTL_SECONDS;

  async function log(row: Record<string, unknown>) {
    const base = {
      job,
      started_at:  startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt.getTime(),
      ...row,
    };
    try {
      // The attribution columns ship in a migration that may not be applied
      // yet, so a rejected insert is retried without them. Losing the record of
      // who started a run is a far smaller loss than losing the record that it
      // ran at all.
      const { error } = await supabase.from("cron_runs").insert({
        ...base,
        triggered_by:         trigger,
        triggered_by_user_id: options.actorId ?? null,
      });
      if (error) await supabase.from("cron_runs").insert(base);
    } catch {
      // best-effort — never let logging break the job
    }
  }

  let holdsLock = false;
  try {
    // Claim the lock before any work. A refused run is deliberately NOT written
    // to cron_runs: nothing happened, and that table records runs that either
    // succeeded or failed. Whoever asked for it is told plainly instead.
    const { data: acquired, error: lockErr } = await supabase.rpc("try_acquire_sync_lock", {
      p_job:         lockKey(job),
      p_ttl_seconds: ttl,
    });
    if (lockErr) throw new Error(`could not claim the run lock: ${lockErr.message}`);
    if (!acquired) return { ok: false, busy: true, error: BUSY_MESSAGE };
    holdsLock = true;

    const detail = await work();
    await log({ status: "success", detail: detail ?? null });
    return { ok: true, detail };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await log({ status: "error", error });
    return { ok: false, busy: false, error };
  } finally {
    if (holdsLock) {
      // Always release, even on throw, so a failed run never keeps the next one
      // out for the whole lease. A release failure is logged, not thrown — the
      // lease expiry is the backstop and we must not mask the original error.
      const { error: relErr } = await supabase.rpc("release_sync_lock", { p_job: lockKey(job) });
      if (relErr) console.error("[cron] run lock release failed", { job, error: relErr.message });
    }
  }
}

/**
 * Wraps a cron job's work: times it, runs it, and records one cron_runs row
 * (success or error) so the Settings → Cron Jobs monitor can show history.
 *
 * Logging is best-effort — a failed insert (e.g. before the migration is
 * applied) never fails the job itself. The caller stays in control of the HTTP
 * response.
 */
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export type CronOutcome =
  | { ok: true;  detail: unknown }
  | { ok: false; error: string };

export async function runCronJob(
  job: string,
  work: () => Promise<unknown>,
): Promise<CronOutcome> {
  const startedAt = new Date();
  const supabase  = createSupabaseAdminClient();

  async function log(row: Record<string, unknown>) {
    try {
      await supabase.from("cron_runs").insert({
        job,
        started_at:  startedAt.toISOString(),
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt.getTime(),
        ...row,
      });
    } catch {
      // best-effort — never let logging break the job
    }
  }

  try {
    const detail = await work();
    await log({ status: "success", detail: detail ?? null });
    return { ok: true, detail };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await log({ status: "error", error });
    return { ok: false, error };
  }
}

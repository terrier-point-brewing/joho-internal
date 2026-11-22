/**
 * What last night's recalculation of a period came back with.
 *
 * A close reruns the recalculation and refuses if any account fails
 * (periodClose.ts). Until now the only way to learn that a step was failing
 * was to press Close or Preview and read the refusal — October 2026's gift card
 * step timed out on 8 nights in 22 and the close page never said so.
 *
 * The nightly balance-close job already records the answer in
 * `cron_runs.detail` (snapshot.errors). This reads it back so the page can show
 * it as a step, ahead of the button.
 *
 * Null means "no nightly run on record for this period", which is the normal
 * state of any month older than the most recently ended one — the job only
 * recalculates that one. It is not the same as clean, and callers must not
 * read it as clean.
 */
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

export interface LastRecalculation {
  /** When the run started. */
  at: string;
  /** snapshotPeriod's errors, verbatim. Empty when the run was clean. */
  errors: string[];
}

export async function readLastRecalculation(supabase: AdminClient, periodEnd: string): Promise<LastRecalculation | null> {
  const { data, error } = await supabase
    .from("cron_runs")
    .select("started_at, detail")
    .eq("job", "balance-close")
    .eq("status", "success")
    .eq("detail->>periodEnd", periodEnd)
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);

  const row = ((data ?? []) as { started_at: string; detail: { snapshot?: { errors?: string[] } } | null }[])[0];
  if (!row) return null;
  return { at: row.started_at, errors: row.detail?.snapshot?.errors ?? [] };
}

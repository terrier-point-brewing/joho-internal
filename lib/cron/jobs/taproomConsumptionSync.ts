/**
 * Reconciles taproom consumption (keg/can sales + draft keg-swaps) from Square
 * into taproom-channel export shipments that drain cold storage.
 *
 * Idempotent — re-derives a trailing window and records only the unrecorded
 * delta per source_ref, so overlapping runs never double-count. The run summary
 * (recorded lines + discrepancies) lands in cron_runs.detail for the Settings →
 * Cron Jobs monitor. Older gaps are backfilled via the on-demand sync route's
 * `?days=N` on the Export Bay.
 *
 * Note it claims a second, finer-grained lease of its own inside
 * runTaproomConsumptionSync, because the Square webhook fires it outside a job
 * run entirely. The run lock here and that lease are different keys and both
 * refuse rather than wait, so neither can deadlock the other.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { runTaproomConsumptionSync } from "@/lib/production/taproomConsumptionSync";
import { fetchUnemailedPhantomAlerts, markPhantomAlertsEmailed } from "@/lib/production/phantomExportAlerts";
import { renderPhantomAlertEmail } from "@/lib/production/phantomAlertEmail";
import { sendEmail, ADMIN_EMAIL } from "@/lib/resend";

const JOB = "taproom-consumption-sync";

/**
 * Baseline look-back.
 *
 * Was 2 days, on the reasoning that the webhook books in real time and the cron
 * only has to cover the last night. That holds only while every miss is a
 * one-off. The misses this job exists to catch are not: a `recipe_square_links`
 * row pointing at a Square variation that had been deleted and recreated hid
 * Epic Hazy and Wiggo can sales for nine days (#387), and seven consecutive
 * failed runs (2026-07-11 → 07-17) hid everything rung in that week. A 2-day
 * window had already moved past both by the time anything ran successfully
 * again, so the loss was permanent and silent.
 *
 * The sync records only `target − already_recorded` per source_ref, so a wider
 * window re-derives more and writes exactly the same rows. The cost is a larger
 * Square order page and a few more no-op comparisons; 40 days measured as three
 * pages. Two weeks buys the slack to survive an outage that lasts a working week.
 */
const WINDOW_DAYS = 14;

/**
 * Ceiling on the catch-up widening below, so a long silence (a job disabled for
 * a month, a restored-from-cold environment) cannot turn one night into an
 * unbounded Square scan. A gap this large is a human's problem, not a cron's —
 * the Export Bay's on-demand sync takes an explicit `?days=N` for that.
 */
const MAX_CATCHUP_DAYS = 45;

export interface WindowPlan {
  days: number;
  /** End of the last window that was actually inspected, or null if unknown. */
  coveredThrough: string | null;
  /** True when the baseline was widened to reach back to `coveredThrough`. */
  widened: boolean;
}

/**
 * Choose this run's look-back so it reaches back to the last window that was
 * genuinely inspected.
 *
 * The old job asked for a fixed 2 days every night regardless of what the
 * previous night managed, which meant a failed run silently handed its days to
 * nobody. Anchoring on the last *inspected* window instead makes the next
 * successful run absorb the gap: seven failed nights become one 8-day window
 * rather than seven days that no run ever looks at again.
 *
 * Only runs that recorded a window count as inspected — a run that threw, or one
 * that skipped because another sync held the lease, never looked at anything and
 * must not be allowed to advance the anchor.
 */
export async function planWindow(supabase: SupabaseClient, now: Date): Promise<WindowPlan> {
  const { data, error } = await supabase
    .from("cron_runs")
    .select("detail")
    .eq("job", JOB)
    .eq("status", "success")
    .not("detail->window->>endIso", "is", null)
    .order("started_at", { ascending: false })
    .limit(1);

  // Best-effort: if the anchor can't be read we still run, just on the baseline.
  // A missing anchor must never be the reason the safety net doesn't fire.
  if (error) return { days: WINDOW_DAYS, coveredThrough: null, widened: false };

  const row = (data ?? [])[0] as { detail?: { window?: { endIso?: string } } } | undefined;
  const coveredThrough = row?.detail?.window?.endIso ?? null;
  if (!coveredThrough) return { days: WINDOW_DAYS, coveredThrough: null, widened: false };

  const gapMs = now.getTime() - Date.parse(coveredThrough);
  if (!Number.isFinite(gapMs)) return { days: WINDOW_DAYS, coveredThrough, widened: false };

  // +1 day of overlap: `trailingWindow` floors the start to a UTC day boundary,
  // and the anchor is a mid-day instant, so covering the gap exactly could leave
  // the hours either side of the boundary unexamined.
  const gapDays = Math.ceil(gapMs / 86400000) + 1;
  const days = Math.min(MAX_CATCHUP_DAYS, Math.max(WINDOW_DAYS, gapDays));
  return { days, coveredThrough, widened: days > WINDOW_DAYS };
}

export async function runTaproomConsumptionJob(supabase: SupabaseClient) {
  const plan = await planWindow(supabase, new Date());
  const result = await runTaproomConsumptionSync(supabase, { days: plan.days });

  // A run that never looked is a failed run, not a quiet one. Reported as an
  // error so it lands in cron_runs with `status: error` and no window — which
  // both surfaces it in the monitor and leaves the catch-up anchor where it was,
  // so tomorrow's run widens to cover tonight instead of writing it off.
  if (result.lockSkipped) {
    throw new Error(
      "taproom consumption sync skipped: another sync run held the lease, so no window was inspected",
    );
  }

  // Best-effort daily digest of open phantom-export alerts (draft swaps that
  // booked excise with no cold-storage stock). Email failure must not fail the
  // sync — it is caught and surfaced in the cron detail, never rethrown.
  let phantomDigest: { emailed: number } | { error: string };
  try {
    const alerts = await fetchUnemailedPhantomAlerts(supabase);
    if (alerts.length > 0) {
      const { subject, html } = renderPhantomAlertEmail(alerts);
      await sendEmail(ADMIN_EMAIL, subject, html);
      await markPhantomAlertsEmailed(supabase, alerts.map((a) => a.exportTransactionId));
    }
    phantomDigest = { emailed: alerts.length };
  } catch (err) {
    phantomDigest = { error: err instanceof Error ? err.message : String(err) };
  }

  return { ...result, catchUp: plan, phantomDigest };
}

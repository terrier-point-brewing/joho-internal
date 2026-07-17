"use client";
import { useState, useEffect } from "react";

/** Whole days elapsed since an ISO timestamp. */
export function daysSince(isoStr: string): number {
  return Math.floor((Date.now() - new Date(isoStr).getTime()) / 86_400_000);
}

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

interface CronRun {
  job: string;
  status: "success" | "error";
  started_at: string;
  error: string | null;
}

interface CronJobMeta {
  job: string;
  maxAgeHours: number;
}

interface CronStatus {
  /** started_at of the most recent successful run of this job, if any. */
  lastSuccessAt: string | null;
  /** True when the most recent attempt (success or not) ended in error. */
  latestFailed: boolean;
  latestError: string | null;
  /** True when the last success is older than the job's registered maxAgeHours. */
  overdue: boolean;
}

const EMPTY_STATUS: CronStatus = { lastSuccessAt: null, latestFailed: false, latestError: null, overdue: false };

/**
 * Pulls this job's real run history from the same cron_runs table the
 * Settings → Cron Jobs monitor reads, instead of a client-side "did I click
 * sync" flag — see SyncPanel doc comment below for why that was misleading.
 */
async function fetchCronStatus(job: string): Promise<CronStatus> {
  try {
    const res = await fetch("/api/admin/cron-runs");
    if (!res.ok) return EMPTY_STATUS;
    const { jobs, runs } = (await res.json()) as { jobs: CronJobMeta[]; runs: CronRun[] };
    const jobRuns = runs.filter((r) => r.job === job); // API orders by started_at desc
    const latest = jobRuns[0] ?? null;
    const lastSuccess = jobRuns.find((r) => r.status === "success") ?? null;
    const maxAgeHours = jobs.find((j) => j.job === job)?.maxAgeHours ?? 25;
    const overdue =
      lastSuccess == null ||
      Date.now() - new Date(lastSuccess.started_at).getTime() > maxAgeHours * 3_600_000;
    return {
      lastSuccessAt: lastSuccess?.started_at ?? null,
      latestFailed: latest?.status === "error",
      latestError: latest?.status === "error" ? latest.error : null,
      overdue,
    };
  } catch {
    return EMPTY_STATUS;
  }
}

export interface SyncPanelProps<T> {
  year: number;
  /** Cron job id from lib/cron/registry.ts backing the "Auto-sync" badge. */
  cronJob: string;
  /**
   * Build the POST endpoint for a manual run. `month` is 1-12 when the month
   * picker is shown, or 0 for a full-year sync / when the picker is hidden.
   */
  buildEndpoint: (opts: { year: number; month: number }) => string;
  /** Trailing button copy, e.g. "from Square" or "Ramp" → "Sync … from Square". */
  label: string;
  showMonthPicker?: boolean;
  onSynced: () => void;
  /** Render the source-specific result summary (orders synced, invoices updated, …). */
  renderResult?: (json: T) => React.ReactNode;
}

/**
 * Shared sync control for the Transactions subtabs: the "Auto-sync: Nd ago"
 * badge (sourced from real cron_runs history for `cronJob`, not a client-side
 * flag — a manual click here doesn't mean the daily cron is healthy, and vice
 * versa), an optional month picker, a manual sync button, and error/result
 * readout for that manual run.
 */
export default function SyncPanel<T>({
  year,
  cronJob,
  buildEndpoint,
  label,
  showMonthPicker = false,
  onSynced,
  renderResult,
}: SyncPanelProps<T>) {
  const [month, setMonth] = useState(() => new Date().getMonth() + 1);
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cronStatus, setCronStatus] = useState<CronStatus>(EMPTY_STATUS);

  useEffect(() => {
    let cancelled = false;
    fetchCronStatus(cronJob).then((status) => {
      if (!cancelled) setCronStatus(status);
    });
    return () => { cancelled = true; };
  }, [cronJob]);

  async function handleSync() {
    setSyncing(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(buildEndpoint({ year, month: showMonthPicker ? month : 0 }), { method: "POST" });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Sync failed");
        return;
      }
      setResult(json as T);
      onSynced();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setSyncing(false);
    }
  }

  const scope = showMonthPicker ? (month === 0 ? "full year" : MONTH_LABELS[month - 1]) : "";
  const days = cronStatus.lastSuccessAt != null ? daysSince(cronStatus.lastSuccessAt) : null;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {days != null && (
        <span className={`text-xs ${cronStatus.overdue ? "text-accent" : "text-muted"}`}>
          Auto-sync: {days === 0 ? "today" : `${days}d ago`}
        </span>
      )}
      {cronStatus.latestFailed && (
        <span className="text-xs text-danger" title={cronStatus.latestError ?? "Last automated sync failed"}>
          ⚠ last auto-sync failed
        </span>
      )}
      {showMonthPicker && (
        <select
          value={month}
          onChange={(e) => { setMonth(Number(e.target.value)); setResult(null); }}
          className="inp-sm w-auto">
          {MONTH_LABELS.map((lbl, i) => <option key={i + 1} value={i + 1}>{lbl}</option>)}
          <option value={0}>Full year</option>
        </select>
      )}
      <button onClick={handleSync} disabled={syncing} className="btn-secondary whitespace-nowrap">
        {syncing
          ? `Syncing${scope ? " " + scope : ""}…`
          : `Sync ${scope ? scope + " " : ""}${label}`}
      </button>
      {error && <span className="text-xs text-danger">{error}</span>}
      {result && renderResult && <span className="text-xs text-secondary">{renderResult(result)}</span>}
    </div>
  );
}

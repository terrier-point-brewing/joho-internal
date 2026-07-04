"use client";
import { useState, useEffect, useCallback } from "react";
import Card from "@/app/components/ui/Card";
import Badge from "@/app/components/ui/Badge";
import Banner from "@/app/components/ui/Banner";

interface CronJobMeta {
  job: string;
  path: string;
  schedule: string;
  scheduleLabel: string;
  description: string;
  maxAgeHours: number;
}

interface CronRun {
  id: string;
  job: string;
  status: "success" | "error";
  started_at: string;
  finished_at: string;
  duration_ms: number | null;
  detail: unknown;
  error: string | null;
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

function hoursSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 3_600_000;
}

function fmtWhen(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function detailSummary(detail: unknown): string {
  if (detail == null) return "";
  if (typeof detail !== "object") return String(detail);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(detail as Record<string, unknown>)) {
    if (v == null || typeof v === "object") continue;
    parts.push(`${k}: ${v}`);
  }
  return parts.join(" · ");
}

export default function CronMonitor() {
  const [jobs, setJobs] = useState<CronJobMeta[]>([]);
  const [runs, setRuns] = useState<CronRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch("/api/admin/cron-runs");
      if (!res.ok) { setError("Failed to load cron history."); return; }
      const data = await res.json() as { jobs: CronJobMeta[]; runs: CronRun[] };
      setJobs(data.jobs ?? []);
      setRuns(data.runs ?? []);
    } catch {
      setError("Failed to load cron history.");
    } finally {
      setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, [load]);

  const runsByJob = new Map<string, CronRun[]>();
  for (const r of runs) {
    if (!runsByJob.has(r.job)) runsByJob.set(r.job, []);
    runsByJob.get(r.job)!.push(r);
  }

  // Registered jobs first, then any job that has runs but isn't registered.
  const registeredIds = new Set(jobs.map((j) => j.job));
  const orphanJobs = [...runsByJob.keys()]
    .filter((j) => !registeredIds.has(j))
    .map((job): CronJobMeta => ({ job, path: "—", schedule: "", scheduleLabel: "Not in registry", description: "Runs recorded, but not in the cron registry.", maxAgeHours: Infinity }));
  const allJobs = [...jobs, ...orphanJobs];

  function toggle(job: string) {
    setExpanded((s) => { const n = new Set(s); if (n.has(job)) n.delete(job); else n.add(job); return n; });
  }

  return (
    <div className="px-4 sm:px-6 py-4 sm:py-6 max-w-3xl">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-sm font-semibold text-strong">Cron Jobs</h2>
          <p className="text-xs text-muted mt-0.5">Scheduled jobs and their recent run history. Schedules run in UTC.</p>
        </div>
        <button onClick={load} disabled={loading} className="btn-ghost btn-sm">
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error && <Banner className="mb-3">{error}</Banner>}

      {loading && jobs.length === 0 ? (
        <p className="text-xs text-muted">Loading…</p>
      ) : (
        <div className="flex flex-col gap-3">
          {allJobs.map((job) => {
            const jobRuns = runsByJob.get(job.job) ?? [];
            const last = jobRuns[0] ?? null;
            const isOpen = expanded.has(job.job);
            const statusTone = !last ? "neutral" : last.status === "success" ? "success" : "danger";
            const statusLabel = !last ? "Never run" : last.status === "success" ? "Success" : "Error";
            const ageHours = last ? hoursSince(last.started_at) : null;
            const overdue = ageHours != null && Number.isFinite(job.maxAgeHours) && ageHours > job.maxAgeHours;

            return (
              <Card key={job.job} padding="p-0">
                <div className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-strong font-mono">{job.job}</span>
                        <Badge tone={statusTone}>{statusLabel}</Badge>
                        {overdue && <Badge tone="accent">Overdue · {Math.round(ageHours!)}h</Badge>}
                        {last && <span className="text-[11px] text-faint">{timeAgo(last.started_at)}</span>}
                      </div>
                      <p className="text-xs text-muted mt-1">{job.description}</p>
                      <p className="text-[11px] text-faint mt-1">
                        {job.scheduleLabel}{job.schedule ? ` · ${job.schedule}` : ""}{job.path !== "—" ? ` · ${job.path}` : ""}
                      </p>
                    </div>
                    {jobRuns.length > 0 && (
                      <button onClick={() => toggle(job.job)} className="text-[11px] text-muted hover:text-body shrink-0">
                        {isOpen ? "Hide runs" : `${jobRuns.length} run${jobRuns.length === 1 ? "" : "s"}`}
                      </button>
                    )}
                  </div>

                  {last && (
                    <div className="mt-2 text-[11px] text-secondary">
                      {last.status === "error"
                        ? <span className="text-danger">{last.error ?? "Error"}</span>
                        : <span className="text-muted">{detailSummary(last.detail) || "ok"}</span>}
                    </div>
                  )}
                </div>

                {isOpen && jobRuns.length > 0 && (
                  <div className="border-t border-line divide-y divide-line/50">
                    {jobRuns.slice(0, 15).map((r) => (
                      <div key={r.id} className="px-4 py-2 flex items-start gap-3 text-[11px]">
                        <span className={`shrink-0 w-14 ${r.status === "success" ? "text-success" : "text-danger"}`}>
                          {r.status === "success" ? "✓ ok" : "✕ error"}
                        </span>
                        <span className="text-muted shrink-0 w-28 tabular-nums">{fmtWhen(r.started_at)}</span>
                        <span className="text-faint shrink-0 w-14 tabular-nums">{fmtDuration(r.duration_ms)}</span>
                        <span className="text-secondary min-w-0 break-words">
                          {r.status === "error"
                            ? <span className="text-danger">{r.error ?? "Error"}</span>
                            : (detailSummary(r.detail) || "—")}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            );
          })}

          <p className="text-[10px] text-faint mt-1">
            Runs are recorded by the jobs themselves. A job with no runs has either never fired or predates run logging.
            Vercel triggers these on the schedules in <span className="font-mono">vercel.json</span>.
          </p>
        </div>
      )}
    </div>
  );
}

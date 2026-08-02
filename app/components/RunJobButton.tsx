"use client";
import { useState } from "react";
import ConfirmDialog from "@/app/components/ui/ConfirmDialog";
import { CRON_JOBS } from "@/lib/cron/registry";

/**
 * Starts one scheduled job by hand, from wherever someone notices it is needed.
 *
 * The same button in Settings and on the Finance transactions tabs, calling the
 * one route that also backs the schedule, so a run started here is locked,
 * timed and recorded exactly like a nightly one.
 *
 * Two behaviours it is worth knowing about.
 *
 * A job that carries a note asks for confirmation first. The note is not
 * decoration — it is there for the jobs that send email, freeze a month, or
 * rebuild something a person may have corrected by hand, and those deserve a
 * pause. A job with nothing to warn about simply runs.
 *
 * A job the registry marks as answering immediately reports that it has started
 * rather than what it found. Those are the ones that page against a bank or
 * against Square for minutes; holding a browser request open for that is a
 * timeout waiting to happen, and the run history is where the answer belongs.
 */
export interface RunJobButtonProps {
  /** Job id, as it appears in the registry and in the run history. */
  job: string;
  /** Button copy. Defaults to "Run now". */
  label?: string;
  /** Called once a run that waited has finished, so the caller can reload. */
  onFinished?: () => void;
}

export default function RunJobButton({ job, label = "Run now", onFinished }: RunJobButtonProps) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  // The registry is plain data with no server dependencies, so both the wording
  // and the wait-or-start decision come straight from the same definition the
  // route uses rather than being restated at each place the button appears.
  const meta = CRON_JOBS.find((j) => j.job === job);

  async function start() {
    setConfirming(false);
    setBusy(true);
    setMessage(null);
    setFailed(false);
    try {
      const res = await fetch(`/api/cron/run/${encodeURIComponent(job)}`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFailed(true);
        setMessage(typeof body.error === "string" ? body.error : "The job could not be started.");
        return;
      }
      setMessage(
        typeof body.message === "string"
          ? body.message
          : "The job finished. Its result is in the run history.",
      );
      onFinished?.();
    } catch {
      setFailed(true);
      setMessage("The job could not be started. Check the connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  // A job the history knows about but the registry does not has nothing behind
  // it to run, so it gets no button rather than one that answers "no such job".
  if (!meta) return null;

  const { manualRun, manualNote } = meta;
  const runningLabel = manualRun === "start" ? "Starting…" : "Running…";

  return (
    <>
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => (manualNote ? setConfirming(true) : start())}
          disabled={busy}
          className="btn-secondary whitespace-nowrap"
        >
          {busy ? runningLabel : label}
        </button>
        {message && (
          <span className={`text-xs ${failed ? "text-danger" : "text-secondary"}`}>{message}</span>
        )}
      </div>

      {confirming && manualNote && (
        <ConfirmDialog
          title="Run this job now?"
          message={
            <div className="space-y-2">
              <p>{manualNote}</p>
              <p className="text-muted">
                {manualRun === "start"
                  ? "It will keep running after this dialog closes. The result appears in the run history."
                  : "This may take a little while. Leave the page open until it finishes."}
              </p>
            </div>
          }
          confirmLabel="Run it"
          tone="primary"
          busy={busy}
          onConfirm={start}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
  );
}

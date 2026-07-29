"use client";

// The chrome every backfill screen shares, so the four of them differ only in
// what they call and how they render their results.
//
// Backfills are one-time, irreversible, whole-table data repairs. They were
// previously reachable only by hand (curl) or buried at the bottom of an
// unrelated feature page, which is how the tips backfill sat un-run for a day
// after its migrations landed. Putting them in Settings makes them findable;
// this shell makes them uniformly *legible* before they are run.
//
// Three things every screen must state before the button, because an operator
// deciding whether to press it needs all three: what it does, what it changes,
// and whether it can be undone.
//
// The preview -> review -> run gate is the same one GlBackfillPanel introduced:
// a live run is unreachable until a clean preview exists, and the preview is
// cleared afterwards so a second run needs a fresh one. Backfills that CANNOT
// preview (see `preview: null`) say so loudly instead of pretending.

import { useState, type ReactNode } from "react";
import Card from "@/app/components/ui/Card";
import Banner from "@/app/components/ui/Banner";

export interface BackfillShellProps<T> {
  title: string;
  /** What the operation does, in one or two sentences. */
  what: ReactNode;
  /** Which tables/figures move as a result. Shown as a distinct "Impacts" line. */
  impacts: ReactNode;
  /**
   * Dry run. `null` means this backfill has no preview mode at all — the shell
   * then hides the preview button, shows a standing warning, and allows the run
   * without a preview gate (there is nothing to gate on).
   */
  preview: (() => Promise<T>) | null;
  apply: () => Promise<T>;
  /** Renders the result table/summary. `mode` distinguishes a preview from a written run. */
  children: (result: T, mode: "preview" | "applied") => ReactNode;
  /**
   * Reasons this preview must not be written, e.g. a non-zero skip count. A
   * non-empty list blocks the run button. Ignored when `preview` is null.
   */
  blockers?: (result: T) => string[];
  /** Extra inputs the operation needs (e.g. a date range). Rendered above the buttons. */
  controls?: ReactNode;
  /** Blocks both buttons while required `controls` inputs are incomplete. */
  disabled?: boolean;
  /** Extra caution shown in the header — for operations that cannot be previewed. */
  danger?: ReactNode;
}

export default function BackfillShell<T>({
  title,
  what,
  impacts,
  preview,
  apply,
  children,
  blockers,
  controls,
  disabled = false,
  danger,
}: BackfillShellProps<T>) {
  const [previewResult, setPreviewResult] = useState<T | null>(null);
  const [applied, setApplied] = useState<T | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<null | "preview" | "run">(null);
  const [error, setError] = useState<string | null>(null);

  const canPreview = preview !== null;
  const found = previewResult !== null ? blockers?.(previewResult) ?? [] : [];
  // With no preview mode there is nothing to gate on, so the run is allowed
  // directly — the standing `danger` warning carries the caution instead.
  const canRun = canPreview ? previewResult !== null && found.length === 0 : true;

  async function go(mode: "preview" | "run") {
    setBusy(mode);
    setError(null);
    try {
      if (mode === "preview") {
        setPreviewResult(await preview!());
        setApplied(null);
      } else {
        setApplied(await apply());
        setPreviewResult(null); // force a fresh preview before any second run
      }
      setConfirming(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const shown = applied ?? previewResult;

  return (
    <div className="flex-1 overflow-auto px-4 sm:px-6 py-4">
      <Card className="max-w-4xl">
        <h2 className="text-sm font-semibold text-strong">{title}</h2>
        <p className="text-xs text-secondary mt-1">{what}</p>
        <p className="text-xs text-secondary mt-2">
          <span className="text-muted">Impacts:</span> {impacts}
        </p>

        <Banner className="mt-3">
          <span className="font-medium">Irreversible.</span> This writes to the production database
          and cannot be undone. Take a backup first, and run it once.
          {danger && <span className="block mt-1">{danger}</span>}
        </Banner>

        {controls && <div className="mt-3">{controls}</div>}

        <div className="flex flex-wrap items-center gap-2 mt-3">
          {canPreview && (
            <button
              onClick={() => go("preview")}
              disabled={busy !== null || disabled}
              className="btn-secondary"
            >
              {busy === "preview" ? "Previewing…" : "Preview changes"}
            </button>
          )}

          {!confirming ? (
            <button
              onClick={() => setConfirming(true)}
              disabled={!canRun || busy !== null || disabled}
              className="btn-primary"
              title={canRun ? undefined : "Run a clean preview first"}
            >
              Run backfill
            </button>
          ) : (
            <>
              {/* Also gated on `disabled`: required inputs can be cleared AFTER
                  entering the confirm state, which would otherwise fire the
                  write with incomplete parameters. */}
              <button
                onClick={() => go("run")}
                disabled={busy !== null || disabled}
                className="btn-danger"
              >
                {busy === "run" ? "Writing…" : "Confirm — write changes"}
              </button>
              <button
                onClick={() => setConfirming(false)}
                disabled={busy !== null}
                className="btn-secondary"
              >
                Cancel
              </button>
            </>
          )}
        </div>

        {error && <Banner className="mt-3">{error}</Banner>}

        {applied && (
          <Banner tone="success" className="mt-3">
            Backfill applied. Re-run the preview if you need to confirm the resulting state.
          </Banner>
        )}

        {previewResult !== null && found.length > 0 && (
          <Banner className="mt-3">
            <span className="font-medium">Not safe to write.</span>
            <ul className="list-disc ml-4 mt-1">
              {found.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </Banner>
        )}

        {shown !== null && (
          <div className="mt-3">{children(shown, applied ? "applied" : "preview")}</div>
        )}
      </Card>
    </div>
  );
}

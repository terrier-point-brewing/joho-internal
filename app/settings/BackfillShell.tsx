"use client";

// The chrome every history-repair ("backfill") screen shares, so the four of
// them differ only in what they call and how they render their results.
//
// Backfills are one-time, irreversible, whole-table data repairs. They were
// previously reachable only by hand (curl) or buried at the bottom of an
// unrelated feature page, which is how the tips backfill sat un-run for a day
// after its migrations landed. Putting them in Settings makes them findable.
//
// The screen says two things up front — one line on what the repair does and
// a row of chips naming what it changes — and keeps the irreversibility
// warning for the confirm step, where the decision is actually made. A
// standing banner on every screen taught operators to skim past it
// (docs/audits/2026-10-16-ui-information-overload-review.md §6, house rule 7).
//
// The preview -> review -> run gate is the same one GlBackfillPanel introduced:
// a live run is unreachable until a clean preview exists, and the preview is
// cleared afterwards so a second run needs a fresh one. Backfills that CANNOT
// preview (see `preview: null`) say so in a chip, and again on confirm.

import { useState, type ReactNode } from "react";
import Card from "@/app/components/ui/Card";
import Badge from "@/app/components/ui/Badge";
import Banner from "@/app/components/ui/Banner";
import ConfirmDialog from "@/app/components/ui/ConfirmDialog";
import SettingsHeader from "./SettingsHeader";

export interface BackfillShellProps<T> {
  title: string;
  /** What the repair does, in one sentence. */
  what: ReactNode;
  /** What it changes — short names, one chip each. */
  changes: string[];
  /**
   * Dry run. `null` means this backfill has no preview mode at all — the shell
   * then hides the preview button, marks the screen "No preview", and allows
   * the run without a preview gate (there is nothing to gate on).
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
  /** Extra caution for the confirm step — for operations that cannot be previewed. */
  danger?: ReactNode;
}

export default function BackfillShell<T>({
  title,
  what,
  changes,
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
  // directly — the confirm step carries the `danger` caution instead.
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
    <div className="flex-1 overflow-auto px-4 sm:px-6">
      <SettingsHeader title={title} />
      <div className="mt-4 pb-4 sm:pb-8">
      <Card className="max-w-4xl">
        <p className="text-xs text-secondary">{what}</p>
        <div className="flex flex-wrap items-center gap-1.5 mt-2">
          <span className="text-2xs text-muted">Changes:</span>
          {changes.map((c) => (
            <Badge key={c}>{c}</Badge>
          ))}
          {!canPreview && (
            <Badge tone="danger" className="ml-1">No preview</Badge>
          )}
        </div>

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
          <button
            onClick={() => setConfirming(true)}
            disabled={!canRun || busy !== null || disabled}
            className="btn-primary"
            title={canRun ? undefined : "Run a clean preview first"}
          >
            {busy === "run" ? "Writing…" : "Repair history"}
          </button>
        </div>

        {/* The irreversibility warning lives here, at the decision, not as a
            standing banner. Also gated on `disabled`: required inputs can be
            cleared AFTER opening the confirm, which would otherwise fire the
            write with incomplete parameters. */}
        {confirming && (
          <ConfirmDialog
            title="Write these changes?"
            confirmLabel="Write changes"
            busy={busy !== null || disabled}
            onConfirm={() => go("run")}
            onCancel={() => setConfirming(false)}
            message={
              <>
                <p>
                  <span className="font-medium">This cannot be undone.</span> It writes to the
                  production database. Take a backup first, and run it once.
                </p>
                {danger && <p className="mt-2">{danger}</p>}
              </>
            }
          />
        )}

        {error && <Banner className="mt-3">{error}</Banner>}

        {applied && (
          <Banner tone="success" className="mt-3">
            Changes written. Re-run the preview to confirm the resulting state.
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
    </div>
  );
}

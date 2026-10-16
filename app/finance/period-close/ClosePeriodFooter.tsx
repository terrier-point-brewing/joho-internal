"use client";
// The act of closing a month, at the bottom of the checklist that leads to it.
//
// ── Why there is a button here at all ────────────────────────────────────────
// There never was one. The nightly cron froze a period once every task was done
// OR its due date had passed, so "final" was something that happened to a month
// rather than something anybody did to it. June 2026 was frozen that way with 6
// of its 45 accounts carrying a balance. Nobody closed June; the 5th of July
// happened.
//
// So this is the missing half. The checklist above says what is outstanding;
// this says who decided it was finished, and when.
//
// ── It shows what is being asserted, not just a button ───────────────────────
// Closing a month is a claim about every account in it, so the three figures
// the claim rests on sit in a strip above the button rather than in prose:
// how many accounts still owe an answer, how many configured accounts actually
// produced a figure (the ones that did not are a disclosure away — somebody
// expected a balance there and none arrived), and the balancing difference the
// close would land at, which is the same column the periods index shows.
//
// ── Refusals arrive as sentences ─────────────────────────────────────────────
// The server recalculates before it closes and refuses on two things it
// genuinely knows: an account still owes an answer, or the recalculation did
// not finish cleanly. Both come back as full sentences naming the accounts, and
// are rendered verbatim. There is no "close anyway" — that is how a month reads
// as final with nothing behind it, only this time with a name attached.

import { useState } from "react";
import Badge from "@/app/components/ui/Badge";
import Banner from "@/app/components/ui/Banner";
import { Modal, Field, ModalActions } from "@/app/components/ui/Modal";
import { formatPeriodLabel, type CloseTasksResponse } from "../closeTasks";
import { formatBalanceCents } from "@/lib/format";

/** What the dry-run recalculation came back with — see the preview button below. */
interface PreviewResult {
  wouldCloseAtCents: number | null;
  errors: string[];
}

async function post(body: unknown): Promise<void> {
  const res = await fetch("/api/finance/balance-close", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(json.error ?? "That did not go through — please try again.");
  }
}

export default function ClosePeriodFooter({
  periodEnd,
  data,
  openCount,
  canManage,
  fmtMoment,
  onDone,
}: {
  periodEnd: string;
  data: CloseTasksResponse | undefined;
  openCount: number;
  canManage: boolean;
  fmtMoment: (iso: string) => string;
  onDone: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [blockers, setBlockers] = useState<string[]>([]);
  const [reopening, setReopening] = useState(false);
  const [closing, setClosing] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);

  if (!data) return null;

  const label = formatPeriodLabel(periodEnd);
  const close = data.close;
  const isClosed = close?.closed ?? false;
  const coverage = data.coverage;

  /**
   * The close's own recalculation, run dry. Answers "what would this month
   * land at?" without freezing anything, so checking the figure stops costing
   * a close-check-reopen loop. The figure is a moment-in-time answer — data
   * entered after it renders is not in it, which is why it names itself
   * a preview rather than pretending to be live.
   */
  async function previewClose() {
    setPreviewing(true);
    setPreview(null);
    try {
      const res = await fetch("/api/finance/balance-close/recompute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "preview", periodEnd }),
      });
      const json = (await res.json().catch(() => ({}))) as Partial<PreviewResult> & { error?: string };
      if (!res.ok) {
        setPreview({ wouldCloseAtCents: null, errors: [json.error ?? "The preview did not go through."] });
        return;
      }
      setPreview({ wouldCloseAtCents: json.wouldCloseAtCents ?? null, errors: json.errors ?? [] });
    } finally {
      setPreviewing(false);
    }
  }

  async function closeMonth(reason: string) {
    setClosing(false);
    setBusy(true);
    setBlockers([]);
    setPreview(null);
    try {
      const res = await fetch("/api/finance/balance-close/recompute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "close-period", periodEnd, ...(reason.trim() ? { reason } : {}) }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string; blockers?: string[] };
        // Prefer the itemised list so each reason gets its own line; fall back
        // to the joined sentence for any error that is not a refusal.
        setBlockers(json.blockers?.length ? json.blockers : [json.error ?? "That did not go through."]);
        return;
      }
      await onDone();
    } finally {
      setBusy(false);
    }
  }

  const actor = close?.actorEmail ?? "(removed user)";
  // A dry run's figure while one is in hand; otherwise the stored snapshot's,
  // which is what the periods index shows for a closed month.
  const balancing = preview ? preview.wouldCloseAtCents : coverage.balancingDifferenceCents;

  return (
    <div className="mt-3 pt-3 border-t border-line/40 flex flex-col gap-3">
      {/* The three figures the close asserts. Shown whether or not the button
          is available, because "is this month actually finished?" is not only
          a question for the person allowed to press it. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Stat label="Outstanding" value={String(openCount)} tone={openCount > 0 ? "accent" : undefined} />
        <Stat
          label="Coverage"
          value={coverage.configured === 0 ? "—" : `${coverage.withBalance} / ${coverage.configured}`}
          title={coverage.configured === 0 ? "No account has a balance source configured." : "Configured accounts that produced a balance"}
          detail={
            coverage.missing.length > 0 ? (
              <details>
                <summary className="cursor-pointer hover:text-secondary select-none">
                  {coverage.missing.length} produced nothing
                </summary>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {coverage.missing.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              </details>
            ) : undefined
          }
        />
        <Stat
          label="Balancing difference"
          value={balancing === null ? "—" : formatBalanceCents(balancing)}
          tone={balancing === null ? undefined : balancing === 0 ? "success" : "danger"}
          detail={
            balancing === null
              ? preview
                ? "Nothing would be computed."
                : canManage && !isClosed
                  ? "Preview to compute"
                  : undefined
              : balancing === 0
                ? "Balanced"
                : preview
                  ? "Still unaccounted for"
                  : "As closed"
          }
        />
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge tone={isClosed ? "success" : "neutral"}>{isClosed ? "Closed" : "Open"}</Badge>
          {isClosed && close && (
            <span className="text-2xs text-muted">
              Closed by {actor} on {fmtMoment(close.at)}
              {close.reason ? ` — “${close.reason}”` : ""}
            </span>
          )}
          {/* Why a previously-closed month is open again. Without this the
              reopen is invisible after the fact and the month simply looks
              unfinished. */}
          {!isClosed && close?.action === "reopened" && (
            <span className="text-2xs text-muted">
              Reopened by {actor} on {fmtMoment(close.at)}
              {close.reason ? ` — “${close.reason}”` : ""}
            </span>
          )}
        </div>

        {canManage &&
          (isClosed ? (
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => setReopening(true)}>
              Reopen {label}
            </button>
          ) : (
            <span className="flex items-center gap-2">
              <button type="button" className="btn-secondary" disabled={busy || previewing} onClick={previewClose}>
                {previewing ? "Recalculating…" : "Preview close"}
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={busy || previewing || openCount > 0}
                onClick={() => setClosing(true)}
                // Said here rather than only on refusal: a disabled button with
                // no explanation is the same dead end as a silent one.
                title={openCount > 0 ? "Every account needs a balance or a recorded reason first." : undefined}
              >
                {busy ? "Closing…" : `Close ${label}`}
              </button>
            </span>
          ))}
      </div>

      {preview && preview.errors.length > 0 && (
        <p className="text-xs text-danger">
          The recalculation did not finish cleanly, so the balancing difference is partial:{" "}
          {preview.errors.join("; ")}
        </p>
      )}

      {blockers.length > 0 && (
        <Banner className="mt-1">
          <span className="block mb-1">{label} cannot be closed yet:</span>
          <ul className="list-disc pl-4 flex flex-col gap-0.5">
            {blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </Banner>
      )}

      {closing && (
        <CloseModal
          label={label}
          onClose={() => setClosing(false)}
          onSubmit={closeMonth}
        />
      )}

      {reopening && (
        <ReopenModal
          label={label}
          periodEnd={periodEnd}
          onClose={() => setReopening(false)}
          onDone={async () => {
            setReopening(false);
            setBlockers([]);
            await onDone();
          }}
          onError={(m) => {
            setReopening(false);
            setBlockers([m]);
          }}
        />
      )}
    </div>
  );
}

/** One figure in the strip above the close button. */
function Stat({
  label,
  value,
  tone,
  title,
  detail,
}: {
  label: string;
  value: string;
  tone?: "accent" | "success" | "danger";
  title?: string;
  detail?: React.ReactNode;
}) {
  const valueCls =
    tone === "danger" ? "text-danger" : tone === "success" ? "text-success" : tone === "accent" ? "text-accent" : "text-strong";
  return (
    <div className="min-w-0" title={title}>
      <p className="text-2xs text-faint uppercase tracking-wide truncate">{label}</p>
      <p className={`text-base sm:text-xl font-semibold font-mono tabular-nums ${valueCls}`}>{value}</p>
      {detail && <div className="text-2xs text-faint">{detail}</div>}
    </div>
  );
}

/**
 * "These books are final" — with room to say what the reader should know.
 *
 * The note is OPTIONAL, unlike the reopen's mandatory reason: a clean month
 * needs no explanation. It exists for the month that closes with a known,
 * documented balancing difference — the decomposition belongs on the record
 * next to the closer's name, not in a chat log.
 */
function CloseModal({
  label,
  onClose,
  onSubmit,
}: {
  label: string;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    await onSubmit(note);
  }

  return (
    <Modal title={`Close ${label}`} onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <p className="text-xs text-secondary">
          {label}&apos;s balances stop recomputing. The month reads as final with your name on it; reopening needs a
          reason.
        </p>
        <Field label="Note for the record (optional)">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. +$822.07 is month-boundary timing: wages paid Jun 2"
            className="inp min-h-20"
            autoFocus
          />
        </Field>
        <ModalActions submitting={submitting} onCancel={onClose} label="Close it" />
      </form>
    </Modal>
  );
}

/**
 * "This month is not final after all, and here is why."
 *
 * The reason is mandatory, for the same reason a skipped account's is. A close
 * is a formal assertion; taking one back without saying why is indistinguishable
 * from never having meant it, and the person who reads the balance sheet next
 * month is entitled to know a figure they relied on moved.
 */
function ReopenModal({
  label,
  periodEnd,
  onClose,
  onDone,
  onError,
}: {
  label: string;
  periodEnd: string;
  onClose: () => void;
  onDone: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await post({ action: "reopen-period", periodEnd, reason });
      await onDone();
    } catch (err) {
      onError(err instanceof Error ? err.message : `Could not reopen ${label}.`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title={`Reopen ${label}`} onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <p className="text-xs text-secondary">
          {label}&apos;s figures can change again until it is closed a second time.
        </p>
        <Field label="Why is this month being reopened?" required>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. a June supplier bill arrived in August and needs to be in June"
            className="inp"
            autoFocus
          />
        </Field>
        <ModalActions submitting={submitting} onCancel={onClose} label="Reopen it" disabled={reason.trim() === ""} />
      </form>
    </Modal>
  );
}

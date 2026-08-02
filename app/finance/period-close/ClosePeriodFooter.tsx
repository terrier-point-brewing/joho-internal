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
// Closing a month is a claim about every account in it, so the coverage line is
// part of the control rather than a detail elsewhere: how many configured
// accounts actually produced a figure, and which ones did not. An account with
// a source that returned nothing is the interesting one — somebody expected a
// balance there and none arrived.
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

  if (!data) return null;

  const label = formatPeriodLabel(periodEnd);
  const close = data.close;
  const isClosed = close?.closed ?? false;
  const coverage = data.coverage;

  async function closeMonth() {
    setBusy(true);
    setBlockers([]);
    try {
      const res = await fetch("/api/finance/balance-close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "close-period", periodEnd }),
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

  return (
    <div className="mt-3 pt-3 border-t border-line/40 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge tone={isClosed ? "success" : "neutral"}>{isClosed ? "Closed" : "Open"}</Badge>
          <span className="text-2xs text-muted">
            {isClosed && close ? (
              <>
                {label} was closed by {close.actorEmail ?? "somebody whose login has since been removed"} on{" "}
                {fmtMoment(close.at)}. Its balances no longer recompute.
              </>
            ) : (
              <>
                {label} is still open, so its balances keep recomputing. Nothing is final until somebody says so.
              </>
            )}
          </span>
        </div>

        {canManage &&
          (isClosed ? (
            <button type="button" className="btn-secondary btn-xxs" disabled={busy} onClick={() => setReopening(true)}>
              Reopen {label}
            </button>
          ) : (
            <button
              type="button"
              className="btn-primary btn-xxs"
              disabled={busy || openCount > 0}
              onClick={closeMonth}
              // Said here rather than only on refusal: a disabled button with
              // no explanation is the same dead end as a silent one.
              title={openCount > 0 ? "Every account needs a balance or a recorded reason first." : undefined}
            >
              {busy ? "Closing…" : `Close ${label}`}
            </button>
          ))}
      </div>

      {/* Why a previously-closed month is open again. Without this the reopen
          is invisible after the fact and the month simply looks unfinished. */}
      {!isClosed && close?.action === "reopened" && (
        <p className="text-2xs text-faint">
          Reopened by {close.actorEmail ?? "somebody whose login has since been removed"} on {fmtMoment(close.at)}
          {close.reason ? ` — “${close.reason}”` : ""}.
        </p>
      )}

      {/* What closing asserts. Shown whether or not the button is available,
          because it is the answer to "is this month actually finished?" and
          that question is not only for the person allowed to press it. */}
      <p className="text-2xs text-faint">
        {coverage.configured === 0
          ? "No account has a balance source configured, so this month has nothing computed behind it."
          : `${coverage.withBalance} of ${coverage.configured} configured account${coverage.configured === 1 ? "" : "s"} produced a balance for ${label}.`}
        {coverage.missing.length > 0 && ` Nothing came through for ${coverage.missing.join(", ")}.`}
      </p>

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
          {label}&apos;s balances will start recomputing again from the next nightly run, so figures on the balance
          sheet for that month can change. Close it again once whatever is being corrected has landed.
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

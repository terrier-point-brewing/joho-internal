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
import Banner from "@/app/components/ui/Banner";
import { Modal, Field, ModalActions } from "@/app/components/ui/Modal";
import {
  balancingDifferenceFor,
  closeBlockersLeft,
  formatPeriodLabel,
  recalculationCheck,
  type CloseTasksResponse,
} from "../closeTasks";
import CloseStep from "./CloseStep";
import { formatBalanceCents } from "@/lib/format";

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
  duplicates,
  canManage,
  fmtMoment,
  onDone,
}: {
  periodEnd: string;
  data: CloseTasksResponse | undefined;
  openCount: number;
  /** Unreviewed possible duplicates the close would refuse over. */
  duplicates: number;
  canManage: boolean;
  fmtMoment: (iso: string) => string;
  onDone: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [blockers, setBlockers] = useState<string[]>([]);
  const [reopening, setReopening] = useState(false);
  const [closing, setClosing] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  if (!data) return null;

  const label = formatPeriodLabel(periodEnd);
  const close = data.close;
  const isClosed = close?.closed ?? false;
  const coverage = data.coverage;

  /**
   * The close's own recalculation, run dry: it computes every account and the
   * balancing difference without storing or freezing anything.
   *
   * The server records the result (recalculationLog.ts), so this only has to
   * refetch. That is what makes a clean check stick: the page reads the most
   * recent recalculation on record, and this one is now it.
   */
  async function previewClose() {
    setPreviewing(true);
    setCheckError(null);
    try {
      const res = await fetch("/api/finance/balance-close/recompute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "preview", periodEnd }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        setCheckError(json.error ?? "The check did not go through. Try it again.");
        return;
      }
      await onDone();
    } catch {
      setCheckError("The check did not go through. Try it again.");
    } finally {
      setPreviewing(false);
    }
  }

  async function closeMonth(reason: string) {
    setClosing(false);
    setBusy(true);
    setBlockers([]);
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
        // The refused close ran a recalculation and recorded it; show it.
        await onDone();
        return;
      }
      await onDone();
    } finally {
      setBusy(false);
    }
  }

  const actor = close?.actorEmail ?? "(removed user)";
  const { cents: balancing, basis: balancingBasis } = balancingDifferenceFor(data);

  const check = recalculationCheck(isClosed ? null : data.recalculation);
  const left = isClosed ? [] : closeBlockersLeft({ openTasks: openCount, duplicates, recalculation: check.state });
  // "Last night's run" for the job, "Checked" for a person: who ran it changes
  // how much weight a reader gives it.
  const checkedWhen = check.at ? `${check.trigger === "manual" ? "Checked" : "Nightly run,"} ${fmtMoment(check.at)}` : "";
  const previous = data.previousClose;
  const movement = balancing !== null && previous ? balancing - previous.balancingDifferenceCents : null;
  const failed = check.errors.length;

  return (
    <>
      <CloseStep
        n={3}
        title="Check the recalculation"
        status={isClosed || check.state === "clean" ? "done" : check.state === "failing" ? "attention" : "review"}
        statusLabel={!isClosed && check.state === "unknown" ? "Not checked" : undefined}
        how={
          <>
            Every night the app recalculates this month&apos;s balances from its feeds. Closing runs it once more and
            refuses if any account fails, so a failure is shown here first.
          </>
        }
      >
        {!isClosed && (
          <div className="flex flex-col gap-2">
            {check.state === "clean" && (
              <p className="text-2xs text-muted">{checkedWhen}: every account recalculated.</p>
            )}
            {check.state === "unknown" && (
              <p className="text-2xs text-muted">
                No recalculation is on record for this month yet.{canManage ? " Press Check now to run one." : ""}
              </p>
            )}
            {check.state === "failing" && (
              <Banner>
                <span className="block mb-1">
                  {checkedWhen}: {failed} account{failed === 1 ? "" : "s"} failed.
                </span>
                <ul className="list-disc pl-4 flex flex-col gap-0.5">
                  {check.errors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
                <span className="block mt-1">
                  This is a fault in the app, not something for you to answer. Press Check again: a timeout often clears
                  on a second try, and a clean check is remembered. If it keeps failing, it needs fixing before {label}{" "}
                  can close.
                </span>
              </Banner>
            )}
            {checkError && <p className="text-xs text-danger">{checkError}</p>}
            {canManage && (
              <button type="button" className="btn-secondary self-start" disabled={busy || previewing} onClick={previewClose}>
                {previewing ? "Recalculating…" : check.state === "unknown" ? "Check now" : "Check again"}
              </button>
            )}
          </div>
        )}
      </CloseStep>

      {/* The figures the close asserts. Shown whether or not the button is
          available, because "is this month actually finished?" is not only a
          question for the person allowed to press it. */}
      <CloseStep
        n={4}
        title="Look at the balancing difference"
        status={balancing === 0 ? "done" : "review"}
        statusLabel={balancing === 0 ? "Balanced" : undefined}
        how={
          <>
            Total assets minus liabilities and equity. $0.00 means the books balance. A difference does not stop the
            close, but closing puts your name to it, so say what it is in the close note if you know.
          </>
        }
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Stat
            label="Balancing difference"
            value={balancing === null ? "—" : formatBalanceCents(balancing)}
            // Red is for something wrong. A difference on a month that is still
            // open is a figure to read, and on a closed month it is a figure
            // somebody already put their name to; neither is an error.
            tone={balancing === null ? undefined : balancing === 0 ? "success" : isClosed ? undefined : "accent"}
            detail={
              balancing === null
                ? canManage && !isClosed
                  ? "Not computed yet. Use the check in step 3."
                  : undefined
                : balancingBasis === "closed"
                  ? "As closed"
                  : balancingBasis === "recalculated" && check.at
                    ? `As of ${fmtMoment(check.at)}`
                    : "As last stored"
            }
          />
          <Stat
            label="Accounts with a balance"
            value={coverage.configured === 0 ? "—" : String(coverage.withBalance)}
            tone={coverage.missing.length > 0 ? "accent" : undefined}
            title={coverage.configured === 0 ? "No account has a balance source configured." : undefined}
            detail={
              coverage.configured === 0 ? undefined : coverage.missing.length > 0 ? (
                <details open>
                  <summary className="cursor-pointer hover:text-secondary select-none">
                    {coverage.missing.length} had a balance in an earlier month and {coverage.missing.length === 1 ? "has" : "have"} none now
                  </summary>
                  <p className="mt-1">Worth a look before closing: a figure was there and has gone.</p>
                  <ul className="mt-1 flex flex-col gap-0.5">
                    {coverage.missing.map((m) => (
                      <li key={m}>{m}</li>
                    ))}
                  </ul>
                </details>
              ) : coverage.neverUsed > 0 ? (
                `Every account that has had a balance before has one. ${coverage.neverUsed} set-up account${coverage.neverUsed === 1 ? " has" : "s have"} never been used.`
              ) : (
                "Every set-up account has a balance."
              )
            }
          />
        </div>
        {movement !== null && previous && (
          <p className="text-xs text-secondary">
            {formatPeriodLabel(previous.periodEnd)} stood at {formatBalanceCents(previous.balancingDifferenceCents)}.{" "}
            {movement === 0
              ? "This month is unchanged."
              : `This month is ${formatBalanceCents(Math.abs(movement))} ${movement < 0 ? "lower" : "higher"}.`}
          </p>
        )}
        {balancing !== null && balancing !== 0 && (
          <p className="text-2xs text-faint max-w-prose">
            The app cannot yet break this figure into its causes. In past months it has mostly been timing: a bill paid
            from the Ramp wallet before month-end that settled after it, wages for a pay period that straddles
            month-end, and taproom cash.
          </p>
        )}
      </CloseStep>

      <CloseStep
        n={5}
        title={`Close ${label}`}
        status={isClosed ? "done" : left.length === 0 ? "todo" : "review"}
        statusLabel={isClosed ? "Closed" : left.length === 0 ? "Ready" : "Not yet"}
        how={
          isClosed ? (
            <>{label}&apos;s figures no longer change. Reopening it needs a reason.</>
          ) : (
            <>
              Closing stops {label}&apos;s figures from changing and records your name against them. It can be reopened
              later with a reason.
            </>
          )
        }
      >
        {/* Said on the page rather than only on refusal or in a hover: a
            disabled button with no explanation is a dead end. */}
        {left.length > 0 && (
          <ul className="text-xs text-secondary list-disc pl-4 flex flex-col gap-0.5">
            {left.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        )}

        <div className="flex items-center gap-3 flex-wrap">
          {canManage &&
            (isClosed ? (
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => setReopening(true)}>
                Reopen {label}
              </button>
            ) : (
              <button
                type="button"
                className="btn-primary"
                disabled={busy || previewing || left.length > 0}
                onClick={() => setClosing(true)}
              >
                {busy ? "Closing…" : `Close ${label}`}
              </button>
            ))}
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

        {blockers.length > 0 && (
          <Banner>
            <span className="block mb-1">{label} cannot be closed yet:</span>
            <ul className="list-disc pl-4 flex flex-col gap-0.5">
              {blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </Banner>
        )}
      </CloseStep>

      {closing && (
        <CloseModal
          label={label}
          balancingCents={balancing}
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
    </>
  );
}

/** One figure in step 4. */
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
  balancingCents,
  onClose,
  onSubmit,
}: {
  label: string;
  /** The difference the month is about to be closed at, so the note is written against the figure. */
  balancingCents: number | null;
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
        {balancingCents !== null && balancingCents !== 0 && (
          <p className="text-xs text-secondary">
            It closes with a balancing difference of{" "}
            <span className="font-mono tabular-nums text-strong">{formatBalanceCents(balancingCents)}</span>. If you know
            what that is, say so below; the note is kept with the close.
          </p>
        )}
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

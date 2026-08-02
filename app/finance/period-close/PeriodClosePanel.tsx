"use client";
// Finance > Period Close — the checklist that does the actual month-end work.
//
// ── Why this got its own section ──────────────────────────────────────────
// The loop already existed and had a hole in the middle of it. The cron raises
// a task per account missing a balance, a banner counts them, the alert email
// says "3 accounts need a balance for July" — and used to drop the reader onto
// a generic year-filtered ledger of every manual entry ever made, which never
// said WHICH accounts were being asked for, by WHEN, or what any of them read
// last month. This panel is what the email actually points at now: the same
// work, with the outstanding accounts stated first, one period at a time.
//
// Entering a balance here writes an ordinary manual_entries row — the exact
// row visible afterward in Finance > Transactions > Manual Entries. The task
// closes itself because reconcileCloseTasks sees that row appear. There is no
// "mark done" button and there must never be one — see the close route.
//
// ── Setup lives in Settings, work lives here ─────────────────────────────────
// Settings > Balance Sheet Accounts declares WHO is responsible and BY WHEN.
// It no longer takes a balance at all for manual entry, which is what made the
// two screens confusable. Rules there, values here.

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/app/production/hooks/queries";
import { queryKeys } from "@/lib/query-keys";
import { formatBalanceCents } from "@/lib/format";
import { formatAmountInput, parseAmountInputCents } from "@/lib/finance/manualEntryAmount";
import { formatPeriodLabel, type CloseTaskDetail, type CloseTasksResponse } from "../closeTasks";
import ClosePeriodFooter from "./ClosePeriodFooter";
import Badge from "@/app/components/ui/Badge";
import Banner from "@/app/components/ui/Banner";
import { Modal, Field, ModalActions } from "@/app/components/ui/Modal";

async function postJson(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(json.error ?? "That did not save — please try again.");
  }
}

/** "2 Aug 2026, 4:12 pm" — a close is an event, so the time matters as much as the day. */
function fmtMoment(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Plain-English deadline, because "due 2026-08-05" does not tell you if you are late. */
function dueLabel(dueDate: string, todayIso: string): { text: string; overdue: boolean } {
  if (todayIso > dueDate) return { text: `overdue since ${fmtDate(dueDate)}`, overdue: true };
  if (todayIso === dueDate) return { text: "due today", overdue: false };
  return { text: `due ${fmtDate(dueDate)}`, overdue: false };
}

// ── One outstanding account ──────────────────────────────────────────────────

function OutstandingRow({
  task,
  periodEnd,
  todayIso,
  onSaved,
  onSkip,
  onError,
}: {
  task: CloseTaskDetail;
  periodEnd: string;
  todayIso: string;
  onSaved: () => Promise<unknown>;
  onSkip: () => void;
  onError: (message: string) => void;
}) {
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const due = dueLabel(task.dueDate, todayIso);

  async function save() {
    const cents = parseAmountInputCents(amount);
    // Blank and unreadable are different mistakes and get different sentences.
    // Zero is neither: it is a real balance for an account like a cash tin, and
    // saying "enter a number" to somebody who entered 0 was the bug that
    // started all of this.
    if (cents === null) {
      onError(
        amount.trim() === ""
          ? `Enter a balance for ${task.accountName} before saving.`
          : "That amount could not be read — type it like 4268.28.",
      );
      return;
    }
    setBusy(true);
    try {
      // The set-or-replace entry point, which also reconciles the close task.
      // Re-entering a figure after checking it again is normal here, so a
      // second save must overwrite rather than answer 409 the way the plain
      // manual-entries POST does.
      await postJson("/api/finance/balance-sources/operator-balance", {
        coaId: task.coaId,
        asOfDate: periodEnd,
        amountCents: cents,
        label: `Month-end balance ${periodEnd}`,
      });
      setAmount("");
      await onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not save that balance.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5 py-3 border-t border-line/40 first:border-t-0">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm text-body">
          {task.accountNumber && <span className="text-muted font-mono mr-1.5">{task.accountNumber}</span>}
          {task.accountName}
        </span>
        <Badge tone={due.overdue ? "danger" : "neutral"}>{due.text}</Badge>
        {/* Named so the reader can tell "mine" from "someone else's" at a
            glance, and so an unassigned account is visibly unassigned rather
            than just quiet. */}
        <span className="text-2xs text-faint">
          {task.responsibleEmail ?? "nobody assigned"}
        </span>
      </div>

      <p className="text-2xs text-faint">
        {task.previousBalance
          ? `Last entered ${formatBalanceCents(task.previousBalance.cents)} as at ${fmtDate(task.previousBalance.asOfDate)}.`
          : "No balance has ever been entered for this account."}
      </p>

      <div className="flex items-center gap-2 flex-wrap mt-0.5">
        <div className="relative">
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted text-xs pointer-events-none">$</span>
          <input
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(formatAmountInput(e.target.value))}
            className="inp-sm w-36 pl-6 text-right font-mono"
            aria-label={`Balance for ${task.accountName}`}
          />
        </div>
        <button type="button" className="btn-primary btn-xxs" disabled={busy} onClick={save}>
          {busy ? "Saving…" : "Save balance"}
        </button>
        <button type="button" className="btn-secondary btn-xxs" disabled={busy} onClick={onSkip}>
          No balance this month
        </button>
      </div>
    </div>
  );
}

// ── Panel ────────────────────────────────────────────────────────────────────
//
// The period comes from the route now (Finance > Period Close > <period>);
// picking a different one happens by going back to the periods index rather
// than by a `<select>` on this page, so this component takes `periodEnd` as a
// prop instead of owning it.

export default function PeriodClosePanel({
  periodEnd,
  canManage,
}: {
  periodEnd: string;
  canManage: boolean;
}) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [skipTarget, setSkipTarget] = useState<CloseTaskDetail | null>(null);
  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const { data } = useQuery({
    queryKey: queryKeys.finance.balanceClose(periodEnd),
    queryFn: () => fetchJson<CloseTasksResponse>(`/api/finance/balance-close?periodEnd=${periodEnd}`),
  });

  async function refresh() {
    await qc.invalidateQueries({ queryKey: ["finance", "balance-close"] });
    await qc.invalidateQueries({ queryKey: ["finance", "manual-entries"] });
  }

  /**
   * Bring the checklist up to date before showing it.
   *
   * Tasks are otherwise only created by the nightly cron, so an account
   * configured this morning has nothing outstanding against it until tomorrow
   * — and the person who just configured it would reasonably conclude the
   * feature does not work. Both halves of the refresh are idempotent by
   * construction (see closeTasks.ts), so running it on arrival costs a query
   * and can never double up.
   */
  useEffect(() => {
    if (!canManage) return;
    let cancelled = false;
    void postJson("/api/finance/balance-close", { action: "refresh", periodEnd })
      .then(() => {
        if (!cancelled) return qc.invalidateQueries({ queryKey: queryKeys.finance.balanceClose(periodEnd) });
      })
      // A refresh failure is not worth a banner: the list below still renders
      // whatever the cron last created, which is the pre-existing behaviour.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [periodEnd, canManage, qc]);

  const tasks = data?.tasks ?? [];
  const open = tasks.filter((t) => t.status === "open");
  const skipped = tasks.filter((t) => t.status === "skipped");
  const completed = tasks.filter((t) => t.status === "completed");

  return (
    <>
      <div className="flex flex-col">
        {error && <Banner className="mb-2">{error}</Banner>}

        {open.length > 0 && (
          <div className="flex flex-col">
            {open.map((task) => (
              <OutstandingRow
                key={task.id}
                task={task}
                periodEnd={periodEnd}
                todayIso={todayIso}
                onSaved={refresh}
                onSkip={() => setSkipTarget(task)}
                onError={setError}
              />
            ))}
          </div>
        )}

        {/* Answered accounts, kept visible rather than disappearing. A checklist
            that empties as you work gives no way to check what you entered, and
            a skipped account's reason is the only record of why a month has a
            gap in it. */}
        {(completed.length > 0 || skipped.length > 0) && (
          <div className="mt-3 pt-3 border-t border-line/40 flex flex-col gap-1">
            {/* The amount sits in its own column rather than after a dash. It
                previously read "Entered 1010 · Cash on Hand — —": one em dash
                was the separator and the other was formatCurrencyCents
                rendering a stored zero, and nothing on screen distinguished
                them. Separating the figure from the name removes the ambiguity
                whatever the figure turns out to be. */}
            {completed.map((t) => (
              <p key={t.id} className="text-2xs text-muted flex items-baseline gap-1.5">
                <span className="text-success">Entered</span>
                <span className="truncate">
                  {t.accountNumber ? `${t.accountNumber} · ` : ""}
                  {t.accountName}
                </span>
                {t.enteredCents !== null && (
                  <span className="ml-auto font-mono tabular-nums text-body shrink-0">
                    {formatBalanceCents(t.enteredCents)}
                  </span>
                )}
              </p>
            ))}
            {skipped.map((t) => (
              <p key={t.id} className="text-2xs text-muted flex items-center gap-1.5 flex-wrap">
                <span className="text-faint">Skipped</span>
                <span>
                  {t.accountNumber ? `${t.accountNumber} · ` : ""}
                  {t.accountName}
                  {t.notes ? ` — “${t.notes}”` : ""}
                </span>
                {canManage && (
                  <button
                    type="button"
                    className="underline text-accent-soft"
                    onClick={() =>
                      postJson("/api/finance/balance-close", { action: "reopen", taskId: t.id })
                        .then(refresh)
                        .catch((err: Error) => setError(err.message))
                    }
                  >
                    put back on the list
                  </button>
                )}
              </p>
            ))}
          </div>
        )}

        {/* The act itself. Deliberately the last thing on the page: the
            checklist above is what makes it possible, and a close button above
            the outstanding work would invite pressing it without reading. */}
        <ClosePeriodFooter
          periodEnd={periodEnd}
          data={data}
          openCount={open.length}
          canManage={canManage}
          fmtMoment={fmtMoment}
          onDone={refresh}
        />
      </div>

      {skipTarget && (
        <SkipModal
          task={skipTarget}
          onClose={() => setSkipTarget(null)}
          onDone={async () => {
            setSkipTarget(null);
            await refresh();
          }}
          onError={setError}
        />
      )}
    </>
  );
}

/**
 * "This account has no balance this month, and here is why."
 *
 * The reason is mandatory, and that is the entire design. A skip with no reason
 * is indistinguishable from ignoring the account, and a period that closes on a
 * pile of those is exactly the false claim the close workflow exists to avoid.
 */
function SkipModal({
  task,
  onClose,
  onDone,
  onError,
}: {
  task: CloseTaskDetail;
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
      await postJson("/api/finance/balance-close", { action: "skip", taskId: task.id, reason });
      await onDone();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not skip that account.");
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title={`No balance for ${task.accountName}`} onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <p className="text-xs text-secondary">
          This records that {task.accountName} genuinely had nothing to report for{" "}
          {formatPeriodLabel(task.periodEnd)}, rather than that it was missed. It does not enter a balance, and the
          account will read as unsourced for the month.
        </p>
        <Field label="Why is there no balance?" required>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. the till was emptied and the account closed in June"
            className="inp"
            autoFocus
          />
        </Field>
        <ModalActions submitting={submitting} onCancel={onClose} label="Record it" disabled={reason.trim() === ""} />
      </form>
    </Modal>
  );
}

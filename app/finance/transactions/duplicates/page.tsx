"use client";

// Finance > Transactions > Duplicates — the same payment, recorded twice.
//
// A Ramp bill and the card charge that paid it are two valid rows from two
// feeds, and expensing both doubles the cost. Nothing on the Expenses or Bank
// Ledger grids can show that, because each row is right on its own; it only
// shows when the rows are put side by side. lib/finance/duplicateCandidates.ts
// does the pairing (exact amount, a few days apart, names ignored) and this
// page is where a person answers each pair.
//
// Nothing is set aside until someone says so here, and a month cannot be
// closed while a pair dated in or before it is still unanswered — see
// lib/finance/balances/periodClose.ts.

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/app/production/hooks/queries";
import { usePermissions } from "@/lib/hooks/useUserRole";
import { CAP } from "@/lib/auth/capabilities";
import { queryKeys } from "@/lib/query-keys";
import { formatCurrencyCents } from "@/lib/format";
import { fmtDateLong, fmtDateTime } from "@/lib/utils/formatting";
import { formatPeriodLabel } from "@/lib/finance/balances/periods";
import type { DuplicateCandidate, DuplicateSide } from "@/lib/finance/duplicateCandidates";
import type {
  DuplicateResolution,
  DuplicateReviewList,
  PendingDuplicate,
  ReviewedDuplicate,
} from "@/lib/finance/duplicateReview";
import Badge from "@/app/components/ui/Badge";
import Banner from "@/app/components/ui/Banner";
import ToggleChip from "@/app/components/ui/ToggleChip";
import FilterBar from "@/app/components/ui/FilterBar";
import { Modal, Field, ModalActions } from "@/app/components/ui/Modal";
import { LedgerTable, Th } from "../components/LedgerTable";

type View = "pending" | "reviewed";

const RESOLUTION_LABEL: Record<DuplicateResolution, string> = {
  not_duplicate: "Not a duplicate",
  duplicate_set_aside: "Duplicate — set aside",
  duplicate_corrected: "Duplicate — corrected elsewhere",
};

/** What "set it aside" will actually do to this pair's extra record, in the reader's terms. */
function setAsideEffect(candidate: DuplicateCandidate): string {
  return candidate.duplicate.table === "bank_ledger"
    ? "The bank line is marked as a bill settlement, so it stays off the P&L. The bill stays as the expense."
    : `The ${candidate.duplicate.what.toLowerCase()} is excluded from every statement. The bill stays as the expense. It can be restored on the Expenses tab.`;
}

function SideCell({ side }: { side: DuplicateSide }) {
  return (
    <div className="leading-snug">
      <span className="text-strong">{side.name}</span>
      <div className="text-2xs text-muted">
        {side.what} · {fmtDateLong(side.date)}
      </div>
    </div>
  );
}

function MatchedCell({ candidate }: { candidate: DuplicateCandidate }) {
  return (
    <div className="flex flex-col gap-1.5">
      {candidate.matched.map((side) => (
        <div key={side.ids[0]} className="leading-snug">
          <span className="text-strong">{side.name}</span>
          <div className="text-2xs text-muted">
            {side.what} · {fmtDateLong(side.date)}
            {candidate.matched.length > 1 && <> · {formatCurrencyCents(side.amountCents)}</>}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Answering one pair ───────────────────────────────────────────────────────

function ReviewModal({
  candidate,
  onClose,
  onSaved,
}: {
  candidate: PendingDuplicate;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}) {
  const canSetAside = candidate.setAsideBlocked === null;
  const [resolution, setResolution] = useState<DuplicateResolution | null>(null);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const noteRequired = resolution === "duplicate_corrected";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!resolution) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/finance/duplicates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: candidate.key, resolution, note: note.trim() || null }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        setError(json.error ?? "That did not save — please try again.");
        return;
      }
      await onSaved();
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Is this one transaction, recorded twice?" onClose={onClose}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <p className="text-sm text-body leading-relaxed">{candidate.reason}</p>

        <Field label="Your answer" required>
          <div className="flex flex-col items-start gap-1.5">
            <ToggleChip
              active={resolution === "duplicate_set_aside"}
              onClick={() => setResolution("duplicate_set_aside")}
              disabled={!canSetAside}
            >
              Duplicate — set it aside
            </ToggleChip>
            <ToggleChip active={resolution === "duplicate_corrected"} onClick={() => setResolution("duplicate_corrected")}>
              Duplicate — already corrected elsewhere
            </ToggleChip>
            <ToggleChip active={resolution === "not_duplicate"} onClick={() => setResolution("not_duplicate")}>
              Not a duplicate — two separate transactions
            </ToggleChip>
          </div>
          <p className="text-2xs text-faint mt-1.5 leading-relaxed">
            {resolution === "duplicate_set_aside"
              ? setAsideEffect(candidate)
              : resolution === "duplicate_corrected"
                ? "Nothing is changed. This records that the double count has been reversed some other way, so it is not asked again."
                : resolution === "not_duplicate"
                  ? "Nothing is changed. Both records stay on the books and this pair is not asked again."
                  : candidate.setAsideBlocked ?? "Nothing changes until you save."}
          </p>
        </Field>

        <Field label="Note" required={noteRequired} hint={noteRequired ? "which entry reverses it" : "optional"}>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            className="inp w-full"
            placeholder={noteRequired ? "e.g. Reversed by the October manual entry on 5110" : ""}
          />
        </Field>

        {error && <Banner>{error}</Banner>}

        <ModalActions
          submitting={submitting}
          onCancel={onClose}
          label="Save answer"
          disabled={!resolution || (noteRequired && note.trim() === "")}
        />
      </form>
    </Modal>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function DuplicatesPage() {
  const qc = useQueryClient();
  const { can } = usePermissions();
  const canManage = can(CAP.financeTransactionsManage);

  const [view, setView] = useState<View>("pending");
  const [reviewing, setReviewing] = useState<PendingDuplicate | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, isLoading, error: loadError } = useQuery({
    queryKey: queryKeys.finance.duplicates(),
    queryFn: () => fetchJson<DuplicateReviewList>("/api/finance/duplicates"),
  });

  async function refresh() {
    await qc.invalidateQueries({ queryKey: queryKeys.finance.duplicates() });
    // An answer changes what a close would refuse, and a set-aside changes the
    // grids the record lives on.
    await qc.invalidateQueries({ queryKey: ["finance", "balance-close"] });
    await qc.invalidateQueries({ queryKey: ["finance", "expenses"] });
    await qc.invalidateQueries({ queryKey: ["finance", "bank-ledger"] });
  }

  async function askAgain(row: ReviewedDuplicate) {
    setActionError(null);
    const res = await fetch(`/api/finance/duplicates?key=${encodeURIComponent(row.candidate.key)}`, { method: "DELETE" });
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      setActionError(json.error ?? "That did not go through.");
      return;
    }
    await refresh();
  }

  const pending = data?.pending ?? [];
  const reviewed = data?.reviewed ?? [];

  return (
    <>
      <div className="shrink-0 px-4 sm:px-6 py-2">
        <FilterBar>
          <ToggleChip active={view === "pending"} onClick={() => setView("pending")}>
            To review{data ? ` (${pending.length})` : ""}
          </ToggleChip>
          <ToggleChip active={view === "reviewed"} onClick={() => setView("reviewed")}>
            Reviewed{data ? ` (${reviewed.length})` : ""}
          </ToggleChip>
        </FilterBar>
      </div>

      {loadError && (
        <Banner className="mx-4 sm:mx-6 my-2">
          {loadError instanceof Error ? loadError.message : "Failed to load possible duplicates."}
        </Banner>
      )}
      {actionError && <Banner className="mx-4 sm:mx-6 my-2">{actionError}</Banner>}

      {isLoading ? (
        <div className="flex-1 flex items-center justify-center"><p className="text-xs text-muted">Loading…</p></div>
      ) : view === "pending" ? (
        pending.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-center px-6">
            <div>
              <p className="text-sm text-secondary">Nothing to review.</p>
              <p className="text-xs text-faint mt-1">
                No bill, card charge, bank line or manual entry shares an exact amount with another within a few days.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col px-4 sm:px-6 py-4">
            <LedgerTable
              fill
              head={
                <>
                  <Th label="Month" />
                  <Th label="Amount" align="right" />
                  <Th label="Already on the books" />
                  <Th label="Possible duplicate" />
                  <Th label="Apart" align="right" />
                  <Th />
                </>
              }
            >
              {pending.map((c) => (
                <tr key={c.key} className="border-b border-line last:border-0 hover:bg-surface-mid/30 align-top">
                  <td className="px-4 py-2 whitespace-nowrap">
                    <span className="text-body">{formatPeriodLabel(c.periodEnd)}</span>
                    {c.periodClosed && <Badge className="ml-2">Closed</Badge>}
                  </td>
                  <td className="px-4 py-2 text-right font-mono tabular-nums text-strong whitespace-nowrap">
                    {formatCurrencyCents(Math.abs(c.amountCents))}
                  </td>
                  <td className="px-4 py-2"><MatchedCell candidate={c} /></td>
                  <td className="px-4 py-2"><SideCell side={c.duplicate} /></td>
                  <td className="px-4 py-2 text-right text-muted whitespace-nowrap">
                    {c.daysApart === 0 ? "Same day" : `${c.daysApart} day${c.daysApart === 1 ? "" : "s"}`}
                  </td>
                  <td className="px-4 py-2 text-right whitespace-nowrap">
                    {canManage && (
                      <button type="button" className="btn-primary" onClick={() => setReviewing(c)}>
                        Review
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </LedgerTable>
          </div>
        )
      ) : reviewed.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-center px-6">
          <p className="text-sm text-secondary">No pair has been reviewed yet.</p>
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col px-4 sm:px-6 py-4">
          <LedgerTable
            fill
            head={
              <>
                <Th label="Month" />
                <Th label="Amount" align="right" />
                <Th label="Already on the books" />
                <Th label="Possible duplicate" />
                <Th label="Answer" />
                <Th label="Reviewed" />
                <Th />
              </>
            }
          >
            {reviewed.map((r) => (
              <tr key={r.candidate.key} className="border-b border-line last:border-0 hover:bg-surface-mid/30 align-top">
                <td className="px-4 py-2 whitespace-nowrap text-body">{formatPeriodLabel(r.candidate.periodEnd)}</td>
                <td className="px-4 py-2 text-right font-mono tabular-nums text-strong whitespace-nowrap">
                  {formatCurrencyCents(Math.abs(r.candidate.amountCents))}
                </td>
                <td className="px-4 py-2"><MatchedCell candidate={r.candidate} /></td>
                <td className="px-4 py-2"><SideCell side={r.candidate.duplicate} /></td>
                <td className="px-4 py-2">
                  <Badge tone={r.resolution === "not_duplicate" ? "neutral" : "success"}>{RESOLUTION_LABEL[r.resolution]}</Badge>
                  {r.note && <p className="text-2xs text-muted mt-1 max-w-xs">“{r.note}”</p>}
                </td>
                <td className="px-4 py-2 text-2xs text-faint">
                  {r.reviewedByEmail ?? "somebody whose login has since been removed"}
                  <div>{fmtDateTime(r.reviewedAt)}</div>
                </td>
                <td className="px-4 py-2 text-right whitespace-nowrap">
                  {/* A set-aside is undone where the exclusion is visible, not
                      here: removing this record would not bring the row back. */}
                  {canManage && r.resolution !== "duplicate_set_aside" && (
                    <button type="button" className="btn-secondary" onClick={() => askAgain(r)}>
                      Ask again
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </LedgerTable>
        </div>
      )}

      {reviewing && <ReviewModal candidate={reviewing} onClose={() => setReviewing(null)} onSaved={refresh} />}
    </>
  );
}

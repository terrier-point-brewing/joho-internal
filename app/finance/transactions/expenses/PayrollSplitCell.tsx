"use client";
import { useState } from "react";
import Badge from "@/app/components/ui/Badge";
import ConfirmDialog from "@/app/components/ui/ConfirmDialog";
import type { CoARef } from "../../AccountSelect";
import { prorateAcrossMonths } from "@/lib/finance/payrollPeriodProration";

export interface GlLine {
  chartOfAccountsId: string;
  amountCents: number;
  splitSource: "payroll_auto" | "manual" | null;
  memo?: string | null;
}

export interface PayrollMatchInfo {
  payPeriodId: string;
  periodStart: string; // YYYY-MM-DD
  periodEnd: string;   // YYYY-MM-DD
  hasReport: boolean;
  /** Which of Gusto's two ACH pulls this charge is, when it was matched by
   *  amount. Null for hand-matched rows and rows predating amount matching. */
  matchedComponent?: "net_pay" | "taxes" | null;
}

/** How each debit reads in the ledger. */
const COMPONENT_LABEL: Record<"net_pay" | "taxes", string> = {
  net_pay: "net pay",
  taxes: "taxes",
};

/** The fresh payroll state a mutation returns for its one expense — used to patch that row in place. */
export interface PayrollState {
  payrollMatch: PayrollMatchInfo | null;
  glLines: GlLine[];
}

function accountLabel(accounts: CoARef[], id: string) {
  const a = accounts.find((acc) => acc.id === id);
  if (!a) return id.slice(0, 8) + "…";
  return a.account_number ? `${a.account_number} · ${a.account_name}` : a.account_name;
}

function fmtCents(n: number) {
  return (n / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** "May $210.00 · Jun $210.00" breakdown when a line's pay period spans multiple months; null for a single-month period. */
function fmtMonthBreakdown(amountCents: number, periodStart: string, periodEnd: string): string | null {
  const allocations = prorateAcrossMonths(amountCents, periodStart, periodEnd);
  if (allocations.length <= 1) return null;
  return allocations
    .map(({ monthKey, amountCents: cents }) => {
      const [y, m] = monthKey.split("-").map(Number);
      const label = new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "short" });
      return `${label} ${fmtCents(Math.abs(cents))}`;
    })
    .join(" · ");
}

/** Compact pay-period label, e.g. "Jul 1–15" (same month) or "Jun 28 – Jul 11". */
function fmtPeriod(start: string, end: string): string | null {
  if (!start || !end) return null;
  const parse = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const s = parse(start);
  const e = parse(end);
  const mon = (dt: Date) => dt.toLocaleDateString("en-US", { month: "short" });
  if (s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear()) {
    return `${mon(s)} ${s.getDate()}–${e.getDate()}`;
  }
  return `${mon(s)} ${s.getDate()} – ${mon(e)} ${e.getDate()}`;
}

// ── GL-Account-column summary (compact, non-interactive) ───────────────────────
//
// Shows payroll match/split status at a glance in the GL Account column. The
// full line breakdown + match/recompute/unmatch actions live in the row's
// transaction dropdown (PayrollSplitPanel), NOT in a nested dropdown here.

export function PayrollSplitSummary({ payrollMatch, glLines }: { payrollMatch: PayrollMatchInfo | null; glLines: GlLine[] }) {
  if (!payrollMatch) return <Badge tone="accent">Payroll · unmatched</Badge>;

  const periodLabel = fmtPeriod(payrollMatch.periodStart, payrollMatch.periodEnd);
  const hasSplits = payrollMatch.hasReport && glLines.length > 0;
  const title = periodLabel ? `Pay period ${payrollMatch.periodStart} – ${payrollMatch.periodEnd}` : undefined;

  if (!hasSplits) {
    return (
      <span title={title}>
        <Badge tone="info">{periodLabel ? `Payroll ${periodLabel} · awaiting Gusto` : "Payroll · awaiting Gusto"}</Badge>
      </span>
    );
  }

  // Which debit this is, when the report's amounts established it — strictly
  // more informative than the split count, which only ever restated how many GL
  // buckets the period happens to have. Falls back to the count for
  // hand-matched rows, where nobody has established which debit it is.
  const component = payrollMatch.matchedComponent;
  const detail = component ? COMPONENT_LABEL[component] : `split (${glLines.length})`;
  return (
    <span title={component ? `${title ?? "Pay period"} · matched to the ${COMPONENT_LABEL[component]} debit by amount` : title}>
      <Badge tone="accent">{periodLabel ? `Payroll ${periodLabel} · ${detail}` : `Payroll · ${detail}`}</Badge>
    </span>
  );
}

// ── Transaction-dropdown panel (breakdown + actions) ──────────────────────────

async function postAction(expenseId: string, body: Record<string, unknown>) {
  const res = await fetch(`/api/finance/expenses/${expenseId}/payroll-match`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

interface PayrollSplitPanelProps {
  expenseId: string;
  payrollMatch: PayrollMatchInfo | null;
  glLines: GlLine[];
  accounts: CoARef[];
  // Patches just this expense's payroll state in the parent (no full reload).
  onUpdated: (next: PayrollState) => void;
}

export function PayrollSplitPanel({ expenseId, payrollMatch, glLines, accounts, onUpdated }: PayrollSplitPanelProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);

  async function handleMatch() {
    setBusy(true);
    setError(null);
    try {
      const suggest = await postAction(expenseId, { action: "suggest" });
      if (!suggest.ok) throw new Error(suggest.json?.error ?? "Suggest failed.");
      const suggestedPeriodId = suggest.json?.suggestedPeriodId as string | null;
      if (!suggestedPeriodId) {
        setError("No pay period found within 10 days of this transaction.");
        return;
      }
      const match = await postAction(expenseId, { action: "match", payPeriodId: suggestedPeriodId });
      if (!match.ok) throw new Error(match.json?.error ?? "Match failed.");
      onUpdated(match.json as PayrollState);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Match failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRecompute(confirmOverwriteManual = false) {
    setBusy(true);
    setError(null);
    try {
      const res = await postAction(expenseId, { action: "recompute", confirmOverwriteManual });
      if (res.status === 409) {
        setConfirmOverwrite(true);
        return;
      }
      if (!res.ok) throw new Error(res.json?.error ?? "Recompute failed.");
      onUpdated(res.json as PayrollState);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Recompute failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleUnmatch() {
    setBusy(true);
    setError(null);
    try {
      const res = await postAction(expenseId, { action: "unmatch" });
      if (!res.ok) throw new Error(res.json?.error ?? "Unmatch failed.");
      onUpdated(res.json as PayrollState);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unmatch failed.");
    } finally {
      setBusy(false);
    }
  }

  const periodLabel = payrollMatch ? fmtPeriod(payrollMatch.periodStart, payrollMatch.periodEnd) : null;
  const hasSplits = !!payrollMatch?.hasReport && glLines.length > 0;
  const splitTotal = glLines.reduce((s, l) => s + Math.abs(l.amountCents), 0);

  return (
    <>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="text-2xs text-faint uppercase tracking-wider shrink-0">Payroll split</span>
          {payrollMatch ? (
            <span className="text-xs text-body" title={`Pay period ${payrollMatch.periodStart} – ${payrollMatch.periodEnd}`}>
              Pay period {periodLabel ?? `${payrollMatch.periodStart} – ${payrollMatch.periodEnd}`}
            </span>
          ) : (
            <span className="text-xs text-secondary">Not yet matched to a pay period.</span>
          )}
        </div>

        {!payrollMatch ? (
          <div>
            <button type="button" className="btn-primary btn-xxs" disabled={busy} onClick={handleMatch}>
              {busy ? "Matching…" : "Match payroll period"}
            </button>
          </div>
        ) : !hasSplits ? (
          <div className="flex items-center gap-2">
            <Badge tone="info">Awaiting Gusto upload</Badge>
            <button type="button" className="btn-secondary btn-xxs" disabled={busy} onClick={handleUnmatch}>
              {busy ? "…" : "Unmatch"}
            </button>
          </div>
        ) : (
          <>
            <ul className="text-xs text-secondary space-y-0.5 max-w-[420px]">
              {glLines.map((l, i) => {
                const breakdown = payrollMatch ? fmtMonthBreakdown(l.amountCents, payrollMatch.periodStart, payrollMatch.periodEnd) : null;
                return (
                  <li key={i} className="flex flex-col gap-0.5">
                    <span className="flex items-center justify-between gap-3">
                      <span className="truncate">
                        {accountLabel(accounts, l.chartOfAccountsId)}
                        {l.splitSource === "manual" && (
                          <span title="Manually overridden">
                            <Badge tone="info" className="ml-1">manual</Badge>
                          </span>
                        )}
                      </span>
                      <span className="font-mono text-body shrink-0">{fmtCents(Math.abs(l.amountCents))}</span>
                    </span>
                    {breakdown && <span className="text-2xs text-faint">→ {breakdown}</span>}
                  </li>
                );
              })}
              <li className="flex items-center justify-between gap-3 border-t border-line/40 pt-0.5 mt-0.5 text-body">
                <span className="truncate font-medium">Total</span>
                <span className="font-mono shrink-0">{fmtCents(splitTotal)}</span>
              </li>
            </ul>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="btn-secondary btn-xxs"
                disabled={busy}
                title="Recompute this expense's payroll split from the period's Gusto totals"
                onClick={() => handleRecompute()}
              >
                {busy ? "…" : "↻ Recompute"}
              </button>
              <button type="button" className="btn-secondary btn-xxs" disabled={busy} onClick={handleUnmatch}>
                Unmatch
              </button>
            </div>
          </>
        )}

        {error && <span className="text-2xs text-danger">{error}</span>}
      </div>
      {confirmOverwrite && (
        <ConfirmDialog
          title="Overwrite manual split?"
          message="This expense has a manually-edited payroll split. Overwrite it with the recomputed split from the period's Gusto totals?"
          confirmLabel="Overwrite"
          tone="danger"
          busy={busy}
          onConfirm={() => { setConfirmOverwrite(false); handleRecompute(true); }}
          onCancel={() => setConfirmOverwrite(false)}
        />
      )}
    </>
  );
}

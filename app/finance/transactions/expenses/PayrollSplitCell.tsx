"use client";
import { useState } from "react";
import Badge from "@/app/components/ui/Badge";
import type { CoARef } from "../../AccountSelect";

export interface GlLine {
  chartOfAccountsId: string;
  amountCents: number;
  splitSource: "payroll_auto" | "manual" | null;
}

export interface PayrollMatchInfo {
  payPeriodId: string;
  periodStart: string; // YYYY-MM-DD
  periodEnd: string;   // YYYY-MM-DD
  hasReport: boolean;
}

/** The fresh payroll state a mutation returns for its one expense — used to patch that row in place. */
export interface PayrollState {
  payrollMatch: PayrollMatchInfo | null;
  glLines: GlLine[];
}

interface PayrollSplitCellProps {
  expenseId: string;
  // Gate on this in the parent -- render this cell only when routing ===
  // "payroll_split" (see lib/finance/expenses.ts's resolveExpenseMapping
  // payroll_split skip). Kept as a prop rather than re-derived here so the
  // cell stays presentation-only.
  routing: "single_account" | "payroll_split";
  payrollMatch: PayrollMatchInfo | null;
  glLines: GlLine[];
  accounts: CoARef[];
  // Patches just this expense's payroll state in the parent (no full reload).
  onUpdated: (next: PayrollState) => void;
}

function accountLabel(accounts: CoARef[], id: string) {
  const a = accounts.find((acc) => acc.id === id);
  if (!a) return id.slice(0, 8) + "…";
  return a.account_number ? `${a.account_number} · ${a.account_name}` : a.account_name;
}

function fmtCents(n: number) {
  return (n / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
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

async function postAction(expenseId: string, body: Record<string, unknown>) {
  const res = await fetch(`/api/finance/expenses/${expenseId}/payroll-match`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

export function PayrollSplitCell({ expenseId, payrollMatch, glLines, accounts, onUpdated }: PayrollSplitCellProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

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
        if (window.confirm("This expense has a manually-edited split. Overwrite it with the recomputed payroll split?")) {
          await handleRecompute(true);
        }
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

  if (!payrollMatch) {
    return (
      <div className="flex flex-col gap-0.5">
        <button type="button" className="btn-primary btn-xxs" disabled={busy} onClick={(ev) => { ev.stopPropagation(); handleMatch(); }}>
          {busy ? "Matching…" : "Match payroll period"}
        </button>
        {error && <span className="text-[10px] text-danger">{error}</span>}
      </div>
    );
  }

  const hasSplits = payrollMatch.hasReport && glLines.length > 0;
  const periodLabel = fmtPeriod(payrollMatch.periodStart, payrollMatch.periodEnd);

  if (!hasSplits) {
    return (
      <div className="flex flex-col gap-0.5">
        <span title={periodLabel ? `Matched to pay period ${payrollMatch.periodStart} – ${payrollMatch.periodEnd}` : undefined}>
          <Badge tone="info">
            {periodLabel ? `Payroll ${periodLabel} — awaiting Gusto upload` : "Payroll — awaiting Gusto upload"}
          </Badge>
        </span>
        {error && <span className="text-[10px] text-danger">{error}</span>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className="text-xs text-accent hover:underline"
          title={periodLabel ? `Pay period ${payrollMatch.periodStart} – ${payrollMatch.periodEnd}` : undefined}
          onClick={(ev) => { ev.stopPropagation(); setExpanded((v) => !v); }}
        >
          <Badge tone="accent">{expanded ? "▾" : "▸"} {periodLabel ? `${periodLabel} split` : "Split"} ({glLines.length})</Badge>
        </button>
        <button
          type="button"
          className="btn-secondary btn-xxs"
          disabled={busy}
          title="Recompute this expense's payroll split from the period's Gusto totals"
          onClick={(ev) => { ev.stopPropagation(); handleRecompute(); }}
        >
          ↻
        </button>
      </div>
      {expanded && (
        <ul className="text-[10px] text-secondary space-y-0.5" onClick={(ev) => ev.stopPropagation()}>
          {glLines.map((l, i) => (
            <li key={i} className="flex items-center justify-between gap-2">
              <span className="truncate">
                {accountLabel(accounts, l.chartOfAccountsId)}
                {l.splitSource === "manual" && <span className="text-info ml-1" title="Manually overridden">pin</span>}
              </span>
              <span className="font-mono text-body shrink-0">{fmtCents(Math.abs(l.amountCents))}</span>
            </li>
          ))}
        </ul>
      )}
      {error && <span className="text-[10px] text-danger">{error}</span>}
    </div>
  );
}

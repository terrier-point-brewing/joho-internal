"use client";

import { useState } from "react";
import AccountSelect, { type CoARef } from "../../AccountSelect";
import SaveHint from "@/app/components/ui/SaveHint";
import { formatCurrencyCents } from "@/lib/format";
import { validateManualSplit, splitRemainderCents } from "@/lib/finance/expenseSplits";
import type { GlLine } from "./PayrollSplitCell";

interface DraftLine {
  chartOfAccountsId: string;
  amountCents: number;
  memo: string;
}

/**
 * Editor for manual GL splits. The P&L replaces a split expense's own coding
 * with these lines, so Save stays disabled until they balance to the cent.
 */
export function ManualSplitPanel({
  expenseId,
  parentAmountCents,
  glLines,
  accounts,
  onUpdated,
  onCancel,
}: {
  expenseId: string;
  parentAmountCents: number;
  glLines: GlLine[];
  accounts: CoARef[];
  onUpdated: (next: { glLines: GlLine[]; mapping_source: string }) => void;
  onCancel: () => void;
}) {
  const existing = glLines.filter((l) => l.splitSource === "manual");
  const [lines, setLines] = useState<DraftLine[]>(
    existing.length > 0
      ? existing.map((l) => ({ chartOfAccountsId: l.chartOfAccountsId, amountCents: l.amountCents, memo: l.memo ?? "" }))
      : [
          { chartOfAccountsId: "", amountCents: parentAmountCents, memo: "" },
          { chartOfAccountsId: "", amountCents: 0, memo: "" },
        ],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remainder = splitRemainderCents(lines, parentAmountCents);
  const validation = validateManualSplit(lines, parentAmountCents);

  function patch(i: number, next: Partial<DraftLine>) {
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...next } : l)));
  }

  async function save() {
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/finance/expenses/${expenseId}/splits`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lines: lines.map((l) => ({
          chart_of_accounts_id: l.chartOfAccountsId,
          amount_cents: l.amountCents,
          memo: l.memo.trim() || null,
        })),
      }),
    });
    setSaving(false);
    if (!res.ok) {
      setError(((await res.json()) as { error?: string }).error ?? "Could not save the split");
      return;
    }
    onUpdated((await res.json()) as { glLines: GlLine[]; mapping_source: string });
  }

  async function clear() {
    setSaving(true);
    const res = await fetch(`/api/finance/expenses/${expenseId}/splits`, { method: "DELETE" });
    setSaving(false);
    if (!res.ok) return;
    onUpdated((await res.json()) as { glLines: GlLine[]; mapping_source: string });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="text-2xs text-faint uppercase tracking-wider">Split across GL accounts</div>

      {lines.map((l, i) => (
        <div key={i} className="flex items-center gap-2">
          <AccountSelect
            value={l.chartOfAccountsId || null}
            onChange={(id) => patch(i, { chartOfAccountsId: id ?? "" })}
            accounts={accounts}
            placeholder="— pick an account —"
            shortLabel
            className="w-full max-w-[320px]"
          />
          <input
            className="inp-sm w-28 text-right font-mono tabular-nums"
            value={(l.amountCents / 100).toFixed(2)}
            onChange={(ev) => patch(i, { amountCents: Math.round(Number(ev.target.value || 0) * 100) })}
            inputMode="decimal"
            aria-label={`Split line ${i + 1} amount`}
          />
          <input
            className="inp-sm flex-1"
            value={l.memo}
            onChange={(ev) => patch(i, { memo: ev.target.value })}
            placeholder="Memo (optional)"
            aria-label={`Split line ${i + 1} memo`}
          />
          <button
            type="button"
            className="btn-secondary btn-xxs"
            onClick={() => setLines((ls) => ls.filter((_, idx) => idx !== i))}
            disabled={lines.length <= 2}
          >
            Remove
          </button>
        </div>
      ))}

      <div className="flex items-center gap-3">
        <button
          type="button"
          className="btn-secondary btn-xxs"
          onClick={() => setLines((ls) => [...ls, { chartOfAccountsId: "", amountCents: remainder, memo: "" }])}
        >
          Add line
        </button>
        <span className={remainder === 0 ? "text-2xs text-success" : "text-2xs text-danger"}>
          {remainder === 0 ? "Balanced" : `${formatCurrencyCents(remainder)} unallocated`}
        </span>
        <div className="flex-1" />
        {existing.length > 0 && (
          <button type="button" className="btn-danger btn-xxs" onClick={clear} disabled={saving}>
            Clear split
          </button>
        )}
        <button type="button" className="btn-secondary btn-xxs" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="button" className="btn-primary btn-xxs" onClick={save} disabled={!validation.ok || saving}>
          Save split
        </button>
        <SaveHint saving={saving} />
      </div>

      {!validation.ok && <div className="text-2xs text-danger">{validation.error}</div>}
      {error && <div className="text-2xs text-danger">{error}</div>}
    </div>
  );
}

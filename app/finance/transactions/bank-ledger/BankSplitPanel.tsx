"use client";

import { useState } from "react";
import AccountSelect, { shortAccountName, type CoARef } from "../../AccountSelect";
import SaveHint from "@/app/components/ui/SaveHint";
import { formatCurrencyCents } from "@/lib/format";
import {
  validateBankSplit,
  splitRemainderCents,
  centsFromRaw,
  rawFromCents,
} from "@/lib/finance/bankLedgerSplits";

/** One split line as the grid holds it, in the API's own shape. */
export interface BankSplitRow {
  chart_of_accounts_id: string;
  amount_cents: number;
  memo: string | null;
}

interface DraftLine {
  chartOfAccountsId: string;
  /**
   * Exactly what was typed. The field is bound to this rather than to a
   * re-formatted `amountCents`, because formatting on every keystroke swallows
   * input: from "0.00" with the caret at the end, typing "1" yields "0.001",
   * which rounds back to 0 cents and re-renders as "0.00". The raw string means
   * the field never fights the typist; it is normalized on blur.
   */
  amountRaw: string;
  amountCents: number;
  memo: string;
}

/** The stored allocation, read-only, for a row that is not being edited. */
export function BankSplitSummary({ splits, accounts }: { splits: BankSplitRow[]; accounts: CoARef[] }) {
  const label = (id: string) => {
    const a = accounts.find((c) => c.id === id);
    // An account deleted out from under a stored allocation. Named rather than
    // rendered blank: a line that shows an amount against nothing at all reads
    // as a display bug instead of the data problem it is.
    if (!a) return "Unknown account";
    const short = shortAccountName(a.account_name);
    return a.account_number ? `${a.account_number} · ${short}` : short;
  };
  return (
    <ul className="flex flex-col gap-0.5">
      {splits.map((s, i) => (
        <li key={i} className="flex items-baseline justify-between gap-2 text-2xs">
          <span className="text-secondary truncate">{label(s.chart_of_accounts_id)}</span>
          <span className="font-mono tabular-nums text-body shrink-0">{formatCurrencyCents(s.amount_cents)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Editor for a bank line's GL allocation.
 *
 * The balance sheet REPLACES a split line's own coding with these lines
 * (sumBank/sumBankSplits), so Save stays disabled until they balance to the
 * cent -- the same contract, and the same editor shape, as the expense split.
 */
export function BankSplitPanel({
  rowId,
  parentAmountCents,
  flowType,
  splits,
  accounts,
  onUpdated,
  onCancel,
}: {
  rowId: string;
  parentAmountCents: number;
  flowType: string;
  splits: BankSplitRow[];
  accounts: CoARef[];
  onUpdated: (next: { gl_splits: BankSplitRow[]; chart_of_accounts_id: string | null; mapping_source: string }) => void;
  onCancel: () => void;
}) {
  const [lines, setLines] = useState<DraftLine[]>(
    splits.length > 0
      ? splits.map((s) => ({
          chartOfAccountsId: s.chart_of_accounts_id,
          amountRaw: rawFromCents(s.amount_cents),
          amountCents: s.amount_cents,
          memo: s.memo ?? "",
        }))
      : [
          // Seeded with the whole amount on line 1 and nothing on line 2, so the
          // first thing typed is the FIRST component and the remainder falls out
          // -- rather than two blank fields and arithmetic to do by hand.
          { chartOfAccountsId: "", amountRaw: rawFromCents(parentAmountCents), amountCents: parentAmountCents, memo: "" },
          { chartOfAccountsId: "", amountRaw: rawFromCents(0), amountCents: 0, memo: "" },
        ],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remainder = splitRemainderCents(lines, parentAmountCents);
  const validation = validateBankSplit(lines, parentAmountCents, flowType);

  function patch(i: number, next: Partial<DraftLine>) {
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...next } : l)));
  }

  async function save() {
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/finance/bank-ledger/${rowId}/splits`, {
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
    await res.json();
    onUpdated({
      gl_splits: lines.map((l) => ({
        chart_of_accounts_id: l.chartOfAccountsId,
        amount_cents: l.amountCents,
        memo: l.memo.trim() || null,
      })),
      // The route clears the parent's own account when an allocation replaces
      // it; the grid has to hear that or the row keeps showing the account it no
      // longer has.
      chart_of_accounts_id: null,
      mapping_source: "manual",
    });
  }

  async function clear() {
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/finance/bank-ledger/${rowId}/splits`, { method: "DELETE" });
    setSaving(false);
    if (!res.ok) {
      setError(((await res.json()) as { error?: string }).error ?? "Could not clear the split");
      return;
    }
    await res.json();
    onUpdated({ gl_splits: [], chart_of_accounts_id: null, mapping_source: "manual" });
  }

  return (
    <div className="flex flex-col gap-2 mt-1 rounded border border-line/60 p-2">
      <div className="text-2xs text-faint uppercase tracking-wider">Split across GL accounts</div>

      {lines.map((l, i) => (
        <div key={i} className="flex items-center gap-2">
          <AccountSelect
            value={l.chartOfAccountsId || null}
            onChange={(id) => patch(i, { chartOfAccountsId: id ?? "" })}
            accounts={accounts}
            placeholder="— pick an account —"
            shortLabel
            className="w-full max-w-[260px]"
          />
          <input
            className="inp-sm w-28 text-right font-mono tabular-nums"
            value={l.amountRaw}
            onChange={(ev) => patch(i, { amountRaw: ev.target.value, amountCents: centsFromRaw(ev.target.value) })}
            onBlur={(ev) => patch(i, { amountRaw: rawFromCents(centsFromRaw(ev.target.value)) })}
            inputMode="decimal"
            aria-label={`Split line ${i + 1} amount`}
          />
          <input
            className="inp-sm flex-1 min-w-[120px]"
            value={l.memo}
            onChange={(ev) => patch(i, { memo: ev.target.value })}
            placeholder="What this slice bought (optional)"
            aria-label={`Split line ${i + 1} memo`}
          />
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setLines((ls) => ls.filter((_, idx) => idx !== i))}
            disabled={lines.length <= 2}
          >
            Remove
          </button>
        </div>
      ))}

      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          className="btn-secondary"
          onClick={() => setLines((ls) => [...ls, { chartOfAccountsId: "", amountRaw: rawFromCents(remainder), amountCents: remainder, memo: "" }])}
        >
          Add line
        </button>
        <span className={remainder === 0 ? "text-2xs text-success" : "text-2xs text-danger"}>
          {remainder === 0 ? "Balanced" : `${formatCurrencyCents(remainder)} unallocated`}
        </span>
        <div className="flex-1" />
        {splits.length > 0 && (
          <button type="button" className="btn-danger" onClick={clear} disabled={saving}>
            Clear split
          </button>
        )}
        <button type="button" className="btn-secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="button" className="btn-primary" onClick={save} disabled={!validation.ok || saving}>
          Save split
        </button>
        <SaveHint saving={saving} />
      </div>

      {!validation.ok && <div className="text-2xs text-danger">{validation.error}</div>}
      {error && <div className="text-2xs text-danger">{error}</div>}
    </div>
  );
}

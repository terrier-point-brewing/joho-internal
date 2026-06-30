"use client";

import { useState } from "react";
import { formatCurrencyCents } from "@/lib/format";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/app/production/hooks/queries";
import { useUserRole } from "@/lib/hooks/useUserRole";
import { queryKeys } from "@/lib/query-keys";

type ManualEntry = {
  id: string;
  start_date: string;
  end_date: string;
  amount_cents: number;
  label: string | null;
};

function currency(cents: number) {
  return formatCurrencyCents(cents, 0);
}

function formatWithCommas(raw: string): string {
  const stripped = raw.replace(/,/g, "");
  if (!stripped) return "";
  const dotIdx = stripped.indexOf(".");
  if (dotIdx !== -1) {
    const intPart = stripped.slice(0, dotIdx);
    const decPart = stripped.slice(dotIdx + 1, dotIdx + 3);
    const intNum  = parseInt(intPart, 10);
    const formattedInt = isNaN(intNum) ? intPart : intNum.toLocaleString("en-US");
    return `${formattedInt}.${decPart}`;
  }
  const n = parseInt(stripped, 10);
  return isNaN(n) ? stripped : n.toLocaleString("en-US");
}

function inputToCents(s: string): number | null {
  const n = parseFloat(s.replace(/[^0-9.]/g, ""));
  return isNaN(n) || n < 0 ? null : Math.round(n * 100);
}

function entryDays(entry: ManualEntry): number {
  const s = new Date(entry.start_date + "T00:00:00");
  const e = new Date(entry.end_date   + "T00:00:00");
  return Math.round((e.getTime() - s.getTime()) / 86_400_000) + 1;
}

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// Shared `.inp` primitive; callers append left-padding / alignment modifiers.
const inputCls = "inp";

// ---------------------------------------------------------------------------

export default function ManualEntriesTab() {
  const { role } = useUserRole();
  const isAdmin = role === "admin";
  const qc = useQueryClient();
  const { data: entries = [], isLoading: loading } = useQuery({
    queryKey: queryKeys.taproom.manualEntries(),
    queryFn: () => fetchJson<ManualEntry[]>("/api/manual-entries"),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.taproom.manualEntries() });

  const [deleting, setDeleting] = useState<string | null>(null);

  // Form state
  const [formStart,  setFormStart]  = useState(today());
  const [formEnd,    setFormEnd]    = useState(today());
  const [formAmount, setFormAmount] = useState("");
  const [formLabel,  setFormLabel]  = useState("");
  const [saving,     setSaving]     = useState(false);
  const [saved,      setSaved]      = useState(false);
  const [formError,  setFormError]  = useState("");

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setFormError("");
    const cents = inputToCents(formAmount);
    if (cents === null || cents <= 0) {
      setFormError("Enter a valid amount greater than $0.");
      return;
    }
    if (formStart > formEnd) {
      setFormError("Start date must be on or before end date.");
      return;
    }

    setSaving(true);
    const res = await fetch("/api/manual-entries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        start_date: formStart,
        end_date: formEnd,
        amount_cents: cents,
        label: formLabel.trim() || null,
      }),
    });
    setSaving(false);

    if (!res.ok) {
      setFormError("Save failed — please try again.");
      return;
    }

    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
    setFormAmount("");
    setFormLabel("");
    await refresh();
  }

  async function handleDelete(id: string) {
    setDeleting(id);
    await fetch("/api/manual-entries", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    setDeleting(null);
    await refresh();
  }

  // Group entries by year of start_date for display
  const years = [...new Set(entries.map((e) => e.start_date.slice(0, 4)))].sort((a, b) => b.localeCompare(a));

  return (
    <div className="max-w-3xl space-y-6">
      {/* Add form — admin only */}
      {!isAdmin && (
        <div className="bg-surface border border-line rounded-lg px-5 py-4 text-sm text-muted">
          Manual entries can only be created by admins.
        </div>
      )}
      {isAdmin && <form
        onSubmit={handleAdd}
        className="bg-surface border border-line rounded-lg p-6 space-y-4"
      >
        <div className="grid grid-cols-2 gap-4">
          {/* Start date */}
          <div>
            <label className="block text-xs font-medium text-secondary mb-1.5">Start Date</label>
            <input
              type="date"
              value={formStart}
              onChange={(e) => setFormStart(e.target.value)}
              className={inputCls}
            />
          </div>

          {/* End date */}
          <div>
            <label className="block text-xs font-medium text-secondary mb-1.5">End Date</label>
            <input
              type="date"
              value={formEnd}
              onChange={(e) => setFormEnd(e.target.value)}
              className={inputCls}
            />
          </div>

          {/* Amount */}
          <div>
            <label className="block text-xs font-medium text-secondary mb-1.5">Net Sales Amount</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-sm pointer-events-none">
                $
              </span>
              <input
                type="text"
                inputMode="decimal"
                placeholder="0.00"
                value={formAmount}
                onChange={(e) => setFormAmount(formatWithCommas(e.target.value))}
                className={`${inputCls} pl-7 text-right font-mono`}
              />
            </div>
          </div>

          {/* Label */}
          <div>
            <label className="block text-xs font-medium text-secondary mb-1.5">
              Label <span className="text-faint font-normal">(optional)</span>
            </label>
            <input
              type="text"
              placeholder="e.g. Pre-Square historical data"
              value={formLabel}
              onChange={(e) => setFormLabel(e.target.value)}
              className={inputCls}
            />
          </div>
        </div>

        {formStart && formEnd && formStart <= formEnd && (
          <p className="text-xs text-muted">
            {Math.round((new Date(formEnd + "T00:00:00").getTime() - new Date(formStart + "T00:00:00").getTime()) / 86_400_000) + 1} day window — amount will be prorated by day overlap when applied to a period.
          </p>
        )}

        {formError && (
          <p className="text-xs text-danger">{formError}</p>
        )}

        <button
          type="submit"
          disabled={saving}
          className="btn-amber"
        >
          {saving ? "Saving…" : saved ? "✓ Saved" : "Save Entry"}
        </button>
      </form>}

      {/* Entries list */}
      <div>
        {loading ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : entries.length === 0 ? (
          <p className="text-sm text-faint">No manual entries yet.</p>
        ) : (
          <div className="space-y-4">
            {years.map((y) => {
              const yearEntries = entries
                .filter((e) => e.start_date.startsWith(y))
                .sort((a, b) => b.start_date.localeCompare(a.start_date));

              return (
                <div key={y} className="bg-surface border border-line rounded-lg">
                  <div className="px-4 py-2 border-b border-line text-xs font-semibold text-secondary uppercase tracking-wide">
                    {y}
                  </div>
                  <div className="overflow-x-auto">
                  <table className="w-full text-sm min-w-[520px]">
                    <thead>
                      <tr className="text-xs text-faint border-b border-line">
                        <th className="text-left px-4 py-2 font-medium">Date Range</th>
                        <th className="text-right px-4 py-2 font-medium">Days</th>
                        <th className="text-right px-4 py-2 font-medium">Net Sales</th>
                        <th className="text-right px-4 py-2 font-medium">Per Day</th>
                        <th className="text-left px-4 py-2 font-medium">Label</th>
                        <th className="px-4 py-2" />
                      </tr>
                    </thead>
                    <tbody>
                      {yearEntries.map((entry) => {
                        const days = entryDays(entry);
                        return (
                          <tr
                            key={entry.id}
                            className="border-b border-line/50 last:border-0 hover:bg-surface-mid/30 transition-colors"
                          >
                            <td className="px-4 py-2.5 text-strong font-medium whitespace-nowrap">
                              {fmtDate(entry.start_date)}
                              {entry.start_date !== entry.end_date && (
                                <> – {fmtDate(entry.end_date)}</>
                              )}
                            </td>
                            <td className="px-4 py-2.5 text-right font-mono text-muted">
                              {days}
                            </td>
                            <td className="px-4 py-2.5 text-right font-mono text-primary">
                              {currency(entry.amount_cents)}
                            </td>
                            <td className="px-4 py-2.5 text-right font-mono text-muted">
                              {currency(Math.round(entry.amount_cents / days))}
                            </td>
                            <td className="px-4 py-2.5 text-muted text-xs">
                              {entry.label ?? <span className="text-disabled">—</span>}
                            </td>
                            <td className="px-4 py-2.5 text-right">
                              <button
                                onClick={() => handleDelete(entry.id)}
                                disabled={deleting === entry.id}
                                className="text-xs text-faint hover:text-danger disabled:opacity-40 transition-colors"
                              >
                                {deleting === entry.id ? "…" : "Delete"}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-line-strong text-body font-medium">
                        <td className="px-4 py-2" colSpan={2}>Total</td>
                        <td className="px-4 py-2 text-right font-mono">
                          {currency(yearEntries.reduce((s, e) => s + e.amount_cents, 0))}
                        </td>
                        <td colSpan={3} />
                      </tr>
                    </tfoot>
                  </table>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

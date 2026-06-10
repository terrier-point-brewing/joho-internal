"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/app/production/hooks/queries";
import { useUserRole } from "@/lib/hooks/useUserRole";

const MANUAL_ENTRIES_KEY = ["taproom", "manual-entries"] as const;

type ManualEntry = {
  id: string;
  start_date: string;
  end_date: string;
  amount_cents: number;
  label: string | null;
};

function currency(cents: number) {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency", currency: "USD",
    minimumFractionDigits: 0, maximumFractionDigits: 0,
  });
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

const inputCls =
  "bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 " +
  "placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-amber-500 focus:border-amber-500 " +
  "transition-colors w-full";

// ---------------------------------------------------------------------------

export default function ManualEntriesTab() {
  const { role } = useUserRole();
  const isAdmin = role === "admin";
  const qc = useQueryClient();
  const { data: entries = [], isLoading: loading } = useQuery({
    queryKey: MANUAL_ENTRIES_KEY,
    queryFn: () => fetchJson<ManualEntry[]>("/api/manual-entries"),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: MANUAL_ENTRIES_KEY });

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
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg px-5 py-4 text-sm text-zinc-500">
          Manual entries can only be created by admins.
        </div>
      )}
      {isAdmin && <form
        onSubmit={handleAdd}
        className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 space-y-4"
      >
        <div className="grid grid-cols-2 gap-4">
          {/* Start date */}
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1.5">Start Date</label>
            <input
              type="date"
              value={formStart}
              onChange={(e) => setFormStart(e.target.value)}
              className={inputCls}
            />
          </div>

          {/* End date */}
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1.5">End Date</label>
            <input
              type="date"
              value={formEnd}
              onChange={(e) => setFormEnd(e.target.value)}
              className={inputCls}
            />
          </div>

          {/* Amount */}
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1.5">Net Sales Amount</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 text-sm pointer-events-none">
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
            <label className="block text-xs font-medium text-zinc-400 mb-1.5">
              Label <span className="text-zinc-600 font-normal">(optional)</span>
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
          <p className="text-xs text-zinc-500">
            {Math.round((new Date(formEnd + "T00:00:00").getTime() - new Date(formStart + "T00:00:00").getTime()) / 86_400_000) + 1} day window — amount will be prorated by day overlap when applied to a period.
          </p>
        )}

        {formError && (
          <p className="text-xs text-red-400">{formError}</p>
        )}

        <button
          type="submit"
          disabled={saving}
          className="bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-sm font-medium px-5 py-2 rounded transition-colors"
        >
          {saving ? "Saving…" : saved ? "✓ Saved" : "Save Entry"}
        </button>
      </form>}

      {/* Entries list */}
      <div>
        {loading ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : entries.length === 0 ? (
          <p className="text-sm text-zinc-600">No manual entries yet.</p>
        ) : (
          <div className="space-y-4">
            {years.map((y) => {
              const yearEntries = entries
                .filter((e) => e.start_date.startsWith(y))
                .sort((a, b) => b.start_date.localeCompare(a.start_date));

              return (
                <div key={y} className="bg-zinc-900 border border-zinc-800 rounded-lg">
                  <div className="px-4 py-2 border-b border-zinc-800 text-xs font-semibold text-zinc-400 uppercase tracking-wide">
                    {y}
                  </div>
                  <div className="overflow-x-auto">
                  <table className="w-full text-sm min-w-[520px]">
                    <thead>
                      <tr className="text-xs text-zinc-600 border-b border-zinc-800">
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
                            className="border-b border-zinc-800/50 last:border-0 hover:bg-zinc-800/30 transition-colors"
                          >
                            <td className="px-4 py-2.5 text-zinc-200 font-medium whitespace-nowrap">
                              {fmtDate(entry.start_date)}
                              {entry.start_date !== entry.end_date && (
                                <> – {fmtDate(entry.end_date)}</>
                              )}
                            </td>
                            <td className="px-4 py-2.5 text-right font-mono text-zinc-500">
                              {days}
                            </td>
                            <td className="px-4 py-2.5 text-right font-mono text-zinc-100">
                              {currency(entry.amount_cents)}
                            </td>
                            <td className="px-4 py-2.5 text-right font-mono text-zinc-500">
                              {currency(Math.round(entry.amount_cents / days))}
                            </td>
                            <td className="px-4 py-2.5 text-zinc-500 text-xs">
                              {entry.label ?? <span className="text-zinc-700">—</span>}
                            </td>
                            <td className="px-4 py-2.5 text-right">
                              <button
                                onClick={() => handleDelete(entry.id)}
                                disabled={deleting === entry.id}
                                className="text-xs text-zinc-600 hover:text-red-400 disabled:opacity-40 transition-colors"
                              >
                                {deleting === entry.id ? "…" : "Delete"}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-zinc-700 text-zinc-300 font-medium">
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

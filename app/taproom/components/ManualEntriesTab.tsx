"use client";

import { useEffect, useState } from "react";

type ManualEntry = {
  id: string;
  year: number;
  month: number;
  amount_cents: number;
  label: string | null;
};

const MONTHS = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

const MONTH_ABBR = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function currency(cents: number) {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency", currency: "USD",
    minimumFractionDigits: 0, maximumFractionDigits: 0,
  });
}

function formatWithCommas(raw: string): string {
  // Strip commas for parsing, keep at most one decimal point
  const stripped = raw.replace(/,/g, "");
  if (!stripped) return "";
  const dotIdx = stripped.indexOf(".");
  if (dotIdx !== -1) {
    // Has decimal — format the integer part with commas, preserve up to 2 decimal places
    const intPart = stripped.slice(0, dotIdx);
    const decPart = stripped.slice(dotIdx + 1, dotIdx + 3); // max 2 decimal digits
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

const inputCls =
  "bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 " +
  "placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-amber-500 focus:border-amber-500 " +
  "transition-colors w-full";

const selectCls =
  "bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-100 " +
  "focus:outline-none focus:ring-1 focus:ring-amber-500 w-full";

// ---------------------------------------------------------------------------

export default function ManualEntriesTab() {
  const currentYear  = new Date().getFullYear();
  const currentMonth = new Date().getMonth() + 1;

  const [entries,  setEntries]  = useState<ManualEntry[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);

  // Form state
  const [formYear,   setFormYear]   = useState(currentYear);
  const [formMonth,  setFormMonth]  = useState(currentMonth);
  const [formAmount, setFormAmount] = useState("");
  const [formLabel,  setFormLabel]  = useState("");
  const [saving,     setSaving]     = useState(false);
  const [saved,      setSaved]      = useState(false);
  const [formError,  setFormError]  = useState("");

  useEffect(() => { fetchEntries(); }, []);

  async function fetchEntries() {
    setLoading(true);
    const res = await fetch("/api/manual-entries");
    if (res.ok) setEntries(await res.json());
    setLoading(false);
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setFormError("");
    const cents = inputToCents(formAmount);
    if (cents === null || cents <= 0) {
      setFormError("Enter a valid amount greater than $0.");
      return;
    }

    // Warn if an entry already exists for this month
    const existing = entries.find((x) => x.year === formYear && x.month === formMonth);

    setSaving(true);
    const res = await fetch("/api/manual-entries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        year: formYear,
        month: formMonth,
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
    await fetchEntries();
    // If overwriting, surface a note
    if (existing) setFormError(`Replaced existing entry for ${MONTH_ABBR[formMonth - 1]} ${formYear}.`);
  }

  async function handleDelete(id: string) {
    setDeleting(id);
    await fetch("/api/manual-entries", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    setDeleting(null);
    await fetchEntries();
  }

  // Group entries by year for display
  const years = [...new Set(entries.map((e) => e.year))].sort((a, b) => b - a);

  return (
    <div className="max-w-3xl space-y-6">
      {/* Add form */}
      <form
        onSubmit={handleAdd}
        className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 space-y-4"
      >

        <div className="grid grid-cols-2 gap-4">
          {/* Month */}
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1.5">Month</label>
            <select
              value={formMonth}
              onChange={(e) => setFormMonth(Number(e.target.value))}
              className={selectCls}
            >
              {MONTHS.map((m, i) => (
                <option key={i + 1} value={i + 1}>{m}</option>
              ))}
            </select>
          </div>

          {/* Year */}
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1.5">Year</label>
            <select
              value={formYear}
              onChange={(e) => setFormYear(Number(e.target.value))}
              className={selectCls}
            >
              {[currentYear - 2, currentYear - 1, currentYear, currentYear + 1].map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
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

        {/* Existing entry warning */}
        {entries.some((x) => x.year === formYear && x.month === formMonth) && (
          <p className="text-xs text-amber-500">
            An entry already exists for {MONTHS[formMonth - 1]} {formYear} — saving will overwrite it.
          </p>
        )}

        {formError && (
          <p className={`text-xs ${formError.startsWith("Replaced") ? "text-zinc-400" : "text-red-400"}`}>
            {formError}
          </p>
        )}

        <button
          type="submit"
          disabled={saving}
          className="bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-sm font-medium px-5 py-2 rounded transition-colors"
        >
          {saving ? "Saving…" : saved ? "✓ Saved" : "Save Entry"}
        </button>
      </form>

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
                .filter((e) => e.year === y)
                .sort((a, b) => a.month - b.month);

              return (
                <div key={y} className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
                  <div className="px-4 py-2 border-b border-zinc-800 text-xs font-semibold text-zinc-400 uppercase tracking-wide">
                    {y}
                  </div>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-zinc-600 border-b border-zinc-800">
                        <th className="text-left px-4 py-2 font-medium">Month</th>
                        <th className="text-right px-4 py-2 font-medium">Net Sales</th>
                        <th className="text-right px-4 py-2 font-medium">÷4 (weekly)</th>
                        <th className="text-left px-4 py-2 font-medium">Label</th>
                        <th className="px-4 py-2" />
                      </tr>
                    </thead>
                    <tbody>
                      {yearEntries.map((entry) => (
                        <tr
                          key={entry.id}
                          className="border-b border-zinc-800/50 last:border-0 hover:bg-zinc-800/30 transition-colors"
                        >
                          <td className="px-4 py-2.5 text-zinc-200 font-medium">
                            {MONTHS[entry.month - 1]}
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono text-zinc-100">
                            {currency(entry.amount_cents)}
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono text-zinc-500">
                            {currency(Math.round(entry.amount_cents / 4))}
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
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-zinc-700 text-zinc-300 font-medium">
                        <td className="px-4 py-2">Total</td>
                        <td className="px-4 py-2 text-right font-mono">
                          {currency(yearEntries.reduce((s, e) => s + e.amount_cents, 0))}
                        </td>
                        <td colSpan={3} />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

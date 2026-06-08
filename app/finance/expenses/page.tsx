"use client";
import { useState, useEffect, useCallback, useMemo } from "react";
import FinanceNav from "../FinanceNav";
import type { RampTransaction } from "@/lib/ramp";

function fmt(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function currentMonthRange() {
  const now  = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const to   = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
  return { from, to };
}

export default function ExpensesPage() {
  const { from: defaultFrom, to: defaultTo } = currentMonthRange();
  const [from, setFrom]       = useState(defaultFrom);
  const [to, setTo]           = useState(defaultTo);
  const [txns, setTxns]       = useState<RampTransaction[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [search, setSearch]   = useState("");
  const [groupBy, setGroupBy] = useState<"none" | "category" | "person">("category");

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/finance/ramp/transactions?from=${from}&to=${to}`);
      if (!res.ok) throw new Error((await res.json()).error);
      setTxns(await res.json());
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, [from, to]);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return txns.filter(
      (t) => !q ||
        t.memo.toLowerCase().includes(q) ||
        t.merchant_category_code_description.toLowerCase().includes(q) ||
        `${t.card_holder.first_name} ${t.card_holder.last_name}`.toLowerCase().includes(q)
    );
  }, [txns, search]);

  const cleared   = filtered.filter((t) => t.state === "CLEARED");
  const totalSpend = cleared.reduce((s, t) => s + t.amount, 0);

  // Group helper
  const grouped = useMemo(() => {
    if (groupBy === "none") return null;
    const map: Record<string, { label: string; total: number; txns: RampTransaction[] }> = {};
    for (const t of cleared) {
      const key = groupBy === "category"
        ? t.merchant_category_code_description
        : `${t.card_holder.first_name} ${t.card_holder.last_name}`;
      if (!map[key]) map[key] = { label: key, total: 0, txns: [] };
      map[key].total += t.amount;
      map[key].txns.push(t);
    }
    return Object.values(map).sort((a, b) => b.total - a.total);
  }, [cleared, groupBy]);

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100">
      <FinanceNav />
      <div className="flex-1 overflow-auto p-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div>
            <h1 className="text-lg font-semibold text-zinc-100">Expenses</h1>
            <p className="text-xs text-zinc-500 mt-0.5">Ramp card transactions · Admin only</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
              className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200" />
            <span className="text-zinc-600 text-xs">to</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
              className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200" />
            <button onClick={load}
              className="px-3 py-1 bg-amber-600 hover:bg-amber-500 text-white text-xs rounded transition-colors">
              Apply
            </button>
          </div>
        </div>

        {/* Controls row */}
        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <input
            type="text" placeholder="Search memo, category, person…" value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-xs text-zinc-200 w-64 placeholder-zinc-600"
          />
          <div className="flex items-center gap-1">
            {(["none", "category", "person"] as const).map((g) => (
              <button key={g} onClick={() => setGroupBy(g)}
                className={`px-2.5 py-1 text-xs rounded transition-colors ${groupBy === g ? "bg-zinc-700 text-zinc-100" : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"}`}>
                {g === "none" ? "All" : g === "category" ? "By Category" : "By Person"}
              </button>
            ))}
          </div>
          <div className="ml-auto text-sm font-semibold tabular-nums font-mono text-amber-400">
            {fmt(totalSpend)} total
          </div>
        </div>

        {error && <div className="bg-red-900/30 border border-red-700 rounded p-3 text-sm text-red-300 mb-4">{error}</div>}
        {loading && <div className="text-zinc-500 text-sm">Loading…</div>}

        {!loading && !error && (
          groupBy !== "none" && grouped ? (
            // Grouped view
            <div className="space-y-4">
              {grouped.map((group) => (
                <div key={group.label} className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-2.5 bg-zinc-800/50">
                    <span className="text-sm font-medium text-zinc-200">{group.label}</span>
                    <span className="text-sm font-semibold tabular-nums font-mono text-amber-400">{fmt(group.total)}</span>
                  </div>
                  <table className="w-full text-xs">
                    <tbody>
                      {group.txns.map((t) => (
                        <tr key={t.id} className="border-t border-zinc-800/50 hover:bg-zinc-800/20">
                          <td className="px-4 py-2 text-zinc-500 w-24">{t.user_transaction_time.slice(0, 10)}</td>
                          <td className="px-4 py-2 text-zinc-300">{t.memo || "—"}</td>
                          {groupBy === "category" && (
                            <td className="px-4 py-2 text-zinc-500">
                              {t.card_holder.first_name} {t.card_holder.last_name}
                            </td>
                          )}
                          <td className="px-4 py-2 text-right tabular-nums font-mono text-zinc-200">{fmt(t.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          ) : (
            // Flat list
            <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-zinc-800 text-zinc-500">
                    <th className="px-4 py-2.5 text-left font-medium">Date</th>
                    <th className="px-4 py-2.5 text-left font-medium">Memo</th>
                    <th className="px-4 py-2.5 text-left font-medium">Category</th>
                    <th className="px-4 py-2.5 text-left font-medium">Person</th>
                    <th className="px-4 py-2.5 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {cleared.map((t) => (
                    <tr key={t.id} className="border-t border-zinc-800/50 hover:bg-zinc-800/20">
                      <td className="px-4 py-2 text-zinc-500">{t.user_transaction_time.slice(0, 10)}</td>
                      <td className="px-4 py-2 text-zinc-300">{t.memo || "—"}</td>
                      <td className="px-4 py-2 text-zinc-500">{t.merchant_category_code_description}</td>
                      <td className="px-4 py-2 text-zinc-400">{t.card_holder.first_name} {t.card_holder.last_name}</td>
                      <td className={`px-4 py-2 text-right tabular-nums font-mono ${t.amount < 0 ? "text-emerald-400" : "text-zinc-200"}`}>
                        {fmt(t.amount)}
                      </td>
                    </tr>
                  ))}
                  {cleared.length === 0 && (
                    <tr><td colSpan={5} className="px-4 py-8 text-center text-zinc-600">No transactions found</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>
    </div>
  );
}

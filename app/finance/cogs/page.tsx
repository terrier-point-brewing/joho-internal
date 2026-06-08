"use client";
import { useState, useEffect, useCallback, useMemo } from "react";
import FinanceNav from "../FinanceNav";

interface COGSRow {
  id: string; batch_id: string | null; beer_name: string | null; batch_number: string | null;
  name: string; category: string | null; quantity: number; unit: string | null;
  cost_per_unit: number | null; total_cost: number; date: string; type: "ingredient" | "packaging";
}
interface COGSData {
  ingredient_rows: COGSRow[];
  packaging_rows: COGSRow[];
  totals: { ingredients: number; packaging: number; total: number };
}

function fmt(n: number) { return n.toLocaleString("en-US", { style: "currency", currency: "USD" }); }

function currentMonthRange() {
  const now  = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const to   = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
  return { from, to };
}

export default function COGSPage() {
  const { from: defaultFrom, to: defaultTo } = currentMonthRange();
  const [from, setFrom]       = useState(defaultFrom);
  const [to, setTo]           = useState(defaultTo);
  const [data, setData]       = useState<COGSData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [view, setView]       = useState<"ingredients" | "packaging" | "by_batch">("ingredients");

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/finance/cogs?from=${from}&to=${to}`);
      if (!res.ok) throw new Error((await res.json()).error);
      setData(await res.json());
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, [from, to]);

  useEffect(() => { load(); }, [load]);

  // Grouped by batch for the by_batch view
  const byBatch = useMemo(() => {
    if (!data) return [];
    const map: Record<string, { beer_name: string; batch_number: string | null; ingredients: number; packaging: number; total: number }> = {};
    for (const r of data.ingredient_rows) {
      const key = r.batch_id ?? "unlinked";
      if (!map[key]) map[key] = { beer_name: r.beer_name ?? "Unlinked", batch_number: r.batch_number, ingredients: 0, packaging: 0, total: 0 };
      map[key].ingredients += r.total_cost;
      map[key].total       += r.total_cost;
    }
    for (const r of data.packaging_rows) {
      const key = "unlinked";
      if (!map[key]) map[key] = { beer_name: "Unlinked", batch_number: null, ingredients: 0, packaging: 0, total: 0 };
      map[key].packaging += r.total_cost;
      map[key].total     += r.total_cost;
    }
    return Object.values(map).sort((a, b) => b.total - a.total);
  }, [data]);

  const rows = data ? (view === "ingredients" ? data.ingredient_rows : view === "packaging" ? data.packaging_rows : []) : [];

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100">
      <FinanceNav />
      <div className="flex-1 overflow-auto p-6">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div>
            <h1 className="text-lg font-semibold text-zinc-100">Cost of Goods Sold</h1>
            <p className="text-xs text-zinc-500 mt-0.5">Ingredients + packaging consumed · Admin only</p>
          </div>
          <div className="flex items-center gap-2">
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

        {error && <div className="bg-red-900/30 border border-red-700 rounded p-3 text-sm text-red-300 mb-4">{error}</div>}
        {loading && <div className="text-zinc-500 text-sm">Loading…</div>}

        {data && !loading && (
          <>
            {/* Summary cards */}
            <div className="grid grid-cols-3 gap-4 mb-5">
              {[
                { label: "Ingredients",   value: data.totals.ingredients },
                { label: "Packaging",     value: data.totals.packaging   },
                { label: "Total COGS",    value: data.totals.total       },
              ].map(({ label, value }) => (
                <div key={label} className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
                  <p className="text-xs text-zinc-500 mb-1">{label}</p>
                  <p className="text-xl font-bold font-mono tabular-nums text-amber-400">{fmt(value)}</p>
                </div>
              ))}
            </div>

            {/* View toggle */}
            <div className="flex gap-1 mb-4">
              {([["ingredients", "Ingredients"], ["packaging", "Packaging"], ["by_batch", "By Batch"]] as const).map(([v, l]) => (
                <button key={v} onClick={() => setView(v)}
                  className={`px-3 py-1 text-xs rounded transition-colors ${view === v ? "bg-zinc-700 text-zinc-100" : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"}`}>
                  {l}
                </button>
              ))}
            </div>

            {view === "by_batch" ? (
              <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-zinc-800 text-zinc-500">
                      <th className="px-4 py-2.5 text-left font-medium">Batch</th>
                      <th className="px-4 py-2.5 text-right font-medium">Ingredients</th>
                      <th className="px-4 py-2.5 text-right font-medium">Packaging</th>
                      <th className="px-4 py-2.5 text-right font-medium">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byBatch.map((b, i) => (
                      <tr key={i} className="border-t border-zinc-800/50 hover:bg-zinc-800/20">
                        <td className="px-4 py-2 text-zinc-300">{b.beer_name}{b.batch_number ? ` #${b.batch_number}` : ""}</td>
                        <td className="px-4 py-2 text-right tabular-nums font-mono text-zinc-400">{fmt(b.ingredients)}</td>
                        <td className="px-4 py-2 text-right tabular-nums font-mono text-zinc-400">{fmt(b.packaging)}</td>
                        <td className="px-4 py-2 text-right tabular-nums font-mono text-amber-400 font-semibold">{fmt(b.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-zinc-800 text-zinc-500">
                      <th className="px-4 py-2.5 text-left font-medium">Date</th>
                      <th className="px-4 py-2.5 text-left font-medium">Item</th>
                      <th className="px-4 py-2.5 text-left font-medium">Category</th>
                      {view === "ingredients" && <th className="px-4 py-2.5 text-left font-medium">Batch</th>}
                      <th className="px-4 py-2.5 text-right font-medium">Qty</th>
                      <th className="px-4 py-2.5 text-right font-medium">Unit Cost</th>
                      <th className="px-4 py-2.5 text-right font-medium">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id} className="border-t border-zinc-800/50 hover:bg-zinc-800/20">
                        <td className="px-4 py-2 text-zinc-500">{r.date.slice(0, 10)}</td>
                        <td className="px-4 py-2 text-zinc-300">{r.name}</td>
                        <td className="px-4 py-2 text-zinc-500 capitalize">{r.category ?? "—"}</td>
                        {view === "ingredients" && (
                          <td className="px-4 py-2 text-zinc-500">{r.beer_name ?? "—"}{r.batch_number ? ` #${r.batch_number}` : ""}</td>
                        )}
                        <td className="px-4 py-2 text-right tabular-nums text-zinc-400">{r.quantity} {r.unit ?? ""}</td>
                        <td className="px-4 py-2 text-right tabular-nums font-mono text-zinc-500">{r.cost_per_unit != null ? fmt(r.cost_per_unit) : "—"}</td>
                        <td className="px-4 py-2 text-right tabular-nums font-mono text-amber-400 font-semibold">{fmt(r.total_cost)}</td>
                      </tr>
                    ))}
                    {rows.length === 0 && (
                      <tr><td colSpan={7} className="px-4 py-8 text-center text-zinc-600">No data in this period</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

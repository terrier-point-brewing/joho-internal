"use client";
import { useState, useEffect, useCallback } from "react";
import FinanceNav from "../FinanceNav";

interface PLData {
  period: { from: string; to: string };
  revenue: { taproom: number; invoices: number; manual: number; total: number };
  cogs: { ingredients: number; packaging: number; total: number };
  gross_profit: number;
  operating_expenses: number;
  expenses_by_category: Record<string, number>;
  operating_income: number;
}

function fmt(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function currentMonthRange() {
  const now   = new Date();
  const from  = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const to    = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
  return { from, to };
}

function PLRow({
  label, value, indent = false, bold = false, positive, sub = false,
}: {
  label: string; value: number; indent?: boolean; bold?: boolean; positive?: boolean; sub?: boolean;
}) {
  const color = value >= 0 ? "text-emerald-400" : "text-red-400";
  return (
    <div className={`flex justify-between items-center py-1.5 ${sub ? "border-t border-zinc-800 mt-1" : ""}`}>
      <span className={`text-sm ${indent ? "ml-6 text-zinc-400" : bold ? "text-zinc-100 font-semibold" : "text-zinc-300"}`}>
        {label}
      </span>
      <span className={`text-sm tabular-nums font-mono ${bold ? color : positive !== undefined ? (value >= 0 ? "text-emerald-400" : "text-red-400") : "text-zinc-300"}`}>
        {fmt(value)}
      </span>
    </div>
  );
}

export default function PLPage() {
  const { from: defaultFrom, to: defaultTo } = currentMonthRange();
  const [from, setFrom]     = useState(defaultFrom);
  const [to, setTo]         = useState(defaultTo);
  const [data, setData]     = useState<PLData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/finance/pl?from=${from}&to=${to}`);
      if (!res.ok) throw new Error((await res.json()).error);
      setData(await res.json());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => { load(); }, [load]);

  const sortedExpenses = data
    ? Object.entries(data.expenses_by_category).sort((a, b) => b[1] - a[1])
    : [];

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100">
      <FinanceNav />
      <div className="flex-1 overflow-auto p-6">
        {/* Header + date range */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-lg font-semibold text-zinc-100">Profit & Loss</h1>
            <p className="text-xs text-zinc-500 mt-0.5">Admin only — do not share</p>
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

        {error && (
          <div className="bg-red-900/30 border border-red-700 rounded p-3 text-sm text-red-300 mb-4">{error}</div>
        )}

        {loading && (
          <div className="text-zinc-500 text-sm">Loading…</div>
        )}

        {data && !loading && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* P&L Statement */}
            <div className="lg:col-span-2 bg-zinc-900 border border-zinc-800 rounded-lg p-5">
              <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wide mb-4">
                Statement · {from} → {to}
              </h2>

              {/* Revenue */}
              <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-1">Revenue</p>
              <PLRow label="Taproom (POS)" value={data.revenue.taproom} indent />
              <PLRow label="Contract Brewing (Invoices)" value={data.revenue.invoices} indent />
              {data.revenue.manual !== 0 && <PLRow label="Manual Adjustments" value={data.revenue.manual} indent />}
              <PLRow label="Total Revenue" value={data.revenue.total} bold sub />

              {/* COGS */}
              <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-1 mt-5">Cost of Goods Sold</p>
              <PLRow label="Ingredients" value={-data.cogs.ingredients} indent />
              <PLRow label="Packaging" value={-data.cogs.packaging} indent />
              <PLRow label="Total COGS" value={-data.cogs.total} bold sub />

              {/* Gross Profit */}
              <div className="my-3 border-t border-zinc-700" />
              <PLRow label="Gross Profit" value={data.gross_profit} bold positive />

              {/* Operating Expenses */}
              <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-1 mt-5">Operating Expenses (Ramp)</p>
              {sortedExpenses.map(([cat, amt]) => (
                <PLRow key={cat} label={cat} value={-amt} indent />
              ))}
              <PLRow label="Total Operating Expenses" value={-data.operating_expenses} bold sub />

              {/* Net */}
              <div className="my-3 border-t border-zinc-700" />
              <PLRow label="Net Operating Income" value={data.operating_income} bold positive sub />

              <p className="text-xs text-zinc-600 mt-4">
                * Payroll not included (Ramp card spend only). Add payroll data via manual COGS entries if needed.
              </p>
            </div>

            {/* Summary cards */}
            <div className="flex flex-col gap-4">
              {[
                { label: "Revenue",         value: data.revenue.total,        color: "text-emerald-400" },
                { label: "COGS",            value: -data.cogs.total,           color: "text-amber-400"  },
                { label: "Gross Profit",    value: data.gross_profit,          color: data.gross_profit >= 0 ? "text-emerald-400" : "text-red-400" },
                { label: "OpEx (Ramp)",     value: -data.operating_expenses,   color: "text-amber-400"  },
                { label: "Net Income",      value: data.operating_income,      color: data.operating_income >= 0 ? "text-emerald-400" : "text-red-400" },
              ].map(({ label, value, color }) => (
                <div key={label} className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
                  <p className="text-xs text-zinc-500 mb-1">{label}</p>
                  <p className={`text-xl font-bold font-mono tabular-nums ${color}`}>{fmt(value)}</p>
                </div>
              ))}

              {data.revenue.total > 0 && (
                <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
                  <p className="text-xs text-zinc-500 mb-1">Gross Margin</p>
                  <p className="text-xl font-bold text-zinc-100">
                    {((data.gross_profit / data.revenue.total) * 100).toFixed(1)}%
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

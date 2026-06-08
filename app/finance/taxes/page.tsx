"use client";
import { useState, useEffect, useCallback } from "react";
import FinanceNav from "../FinanceNav";

interface TaxRow {
  id: string; batch_id: string; channel: string; product_type: string;
  quantity: number; unit: string; volume_bbl: number;
  federal_excise_tax_usd: number; state_excise_tax_usd: number; total_excise_tax_usd: number;
  date: string;
}
interface TaxData {
  rows: TaxRow[];
  totals: { volume_bbl: number; federal_excise_tax_usd: number; state_excise_tax_usd: number; total_excise_tax_usd: number };
}

function fmt(n: number) { return n.toLocaleString("en-US", { style: "currency", currency: "USD" }); }
function fmtBbl(n: number) { return n.toFixed(3) + " bbl"; }

function currentYearRange() {
  const y = new Date().getFullYear();
  return { from: `${y}-01-01`, to: `${y}-12-31` };
}

export default function TaxesPage() {
  const { from: defaultFrom, to: defaultTo } = currentYearRange();
  const [from, setFrom]     = useState(defaultFrom);
  const [to, setTo]         = useState(defaultTo);
  const [data, setData]     = useState<TaxData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/finance/taxes?from=${from}&to=${to}`);
      if (!res.ok) throw new Error((await res.json()).error);
      setData(await res.json());
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, [from, to]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100">
      <FinanceNav />
      <div className="flex-1 overflow-auto p-6">
        <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
          <div>
            <h1 className="text-lg font-semibold text-zinc-100">Excise Taxes</h1>
            <p className="text-xs text-zinc-500 mt-0.5">Federal ($3.50/BBL) · NC State ($0.62/gal) · Admin only</p>
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
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
              {[
                { label: "Volume Exported",  value: fmtBbl(data.totals.volume_bbl),         mono: false },
                { label: "Federal Excise",   value: fmt(data.totals.federal_excise_tax_usd), mono: true  },
                { label: "NC State Excise",  value: fmt(data.totals.state_excise_tax_usd),   mono: true  },
                { label: "Total Tax Owed",   value: fmt(data.totals.total_excise_tax_usd),   mono: true  },
              ].map(({ label, value, mono }) => (
                <div key={label} className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
                  <p className="text-xs text-zinc-500 mb-1">{label}</p>
                  <p className={`text-xl font-bold text-amber-400 ${mono ? "font-mono tabular-nums" : ""}`}>{value}</p>
                </div>
              ))}
            </div>

            {/* Detail table */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-zinc-800 text-zinc-500">
                    <th className="px-4 py-2.5 text-left font-medium">Date</th>
                    <th className="px-4 py-2.5 text-left font-medium">Channel</th>
                    <th className="px-4 py-2.5 text-left font-medium">Product</th>
                    <th className="px-4 py-2.5 text-right font-medium">Qty</th>
                    <th className="px-4 py-2.5 text-right font-medium">Volume (BBL)</th>
                    <th className="px-4 py-2.5 text-right font-medium">Federal</th>
                    <th className="px-4 py-2.5 text-right font-medium">NC State</th>
                    <th className="px-4 py-2.5 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.id} className="border-t border-zinc-800/50 hover:bg-zinc-800/20">
                      <td className="px-4 py-2 text-zinc-500">{r.date.slice(0, 10)}</td>
                      <td className="px-4 py-2 text-zinc-400 capitalize">{r.channel?.replace("_", " ")}</td>
                      <td className="px-4 py-2 text-zinc-300 capitalize">{r.unit ?? r.product_type}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-zinc-400">{r.quantity}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-zinc-400">{r.volume_bbl?.toFixed(3) ?? "—"}</td>
                      <td className="px-4 py-2 text-right tabular-nums font-mono text-zinc-300">{fmt(r.federal_excise_tax_usd)}</td>
                      <td className="px-4 py-2 text-right tabular-nums font-mono text-zinc-300">{fmt(r.state_excise_tax_usd)}</td>
                      <td className="px-4 py-2 text-right tabular-nums font-mono text-amber-400 font-semibold">{fmt(r.total_excise_tax_usd)}</td>
                    </tr>
                  ))}
                  {data.rows.length === 0 && (
                    <tr><td colSpan={8} className="px-4 py-8 text-center text-zinc-600">No exports in this period</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            <p className="text-xs text-zinc-600 mt-3">
              Rates: Federal $3.50/BBL (craft brewery &lt;60k BBL/yr) · NC $0.62/gal · Consult your tax advisor for filing.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

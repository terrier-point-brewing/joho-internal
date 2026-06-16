"use client";
import { useState, useEffect } from "react";
import FinanceNav from "../../FinanceNav";
import StatementsNav from "../StatementsNav";
import type { CashFlowResponse, CashFlowMonth } from "@/app/api/finance/statements/cash-flow/route";

// ── Helpers ───────────────────────────────────────────────────────────────────

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function fmtCents(cents: number): string {
  if (cents === 0) return "—";
  const neg = cents < 0;
  const abs = "$" + Math.abs(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return neg ? `(${abs})` : abs;
}

function MoneyCell({ cents, highlight }: { cents: number; highlight?: boolean }) {
  if (cents === 0) return <span className="text-zinc-700">—</span>;
  const neg = cents < 0;
  const abs = "$" + Math.abs(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const text = neg ? `(${abs})` : abs;
  return <span className={highlight ? (neg ? "text-red-400" : "text-amber-300") : neg ? "text-red-400" : "text-zinc-200"}>{text}</span>;
}

function monthLabel(key: string): string {
  const m = parseInt(key.split("-")[1]);
  return MONTH_NAMES[m - 1];
}

// ── Row ───────────────────────────────────────────────────────────────────────

interface RowDef {
  label: string;
  key: keyof CashFlowMonth;
  indent?: boolean;
  subtotal?: boolean;
  highlight?: boolean;
  dimZero?: boolean;
  pending?: string; // shows a pending label instead of zero
}

const ROWS: RowDef[] = [
  { label: "Operating Cash Inflows",        key: "cash_in_cents",          subtotal: true },
  { label: "  Square POS (net sales)",       key: "pos_cents",              indent: true   },
  { label: "  Square Invoices (collected)",  key: "invoices_paid_cents",    indent: true   },
  { label: "Operating Cash Outflows",        key: "cash_out_cents",         subtotal: true, pending: "Ramp not yet connected" },
  { label: "Net Operating Cash Flow",        key: "net_cents",              highlight: true },
];

// ── Page ─────────────────────────────────────────────────────────────────────

export default function CashFlowPage() {
  const now = new Date();
  const currentYear = now.getFullYear();
  const [year, setYear]   = useState(currentYear);
  const [data, setData]   = useState<CashFlowResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]    = useState<string | null>(null);
  const years = Array.from({ length: 5 }, (_, i) => currentYear - i);

  useEffect(() => {
    async function load() {
      setLoading(true); setError(null);
      try {
        const r = await fetch(`/api/finance/statements/cash-flow?year=${year}`);
        const d = await r.json();
        setData(d);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load");
      } finally { setLoading(false); }
    }
    load();
  }, [year]);

  const months = data?.months ?? [];
  const totals = data?.totals;

  return (
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-100">
      <FinanceNav mobile />
      <StatementsNav />

      <div className="shrink-0 px-4 sm:px-6 pt-4 sm:pt-5 pb-3 border-b border-zinc-800 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-base font-semibold text-zinc-100">Cash Flow</h1>
          <p className="text-xs text-zinc-500 mt-0.5">
            {`Full Year ${year}`} · direct method · Square sources only · operating activities
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <select value={year} onChange={(e) => setYear(Number(e.target.value))}
            className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200">
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {loading && (
          <div className="flex items-center justify-center h-32">
            <p className="text-xs text-zinc-600">Loading…</p>
          </div>
        )}
        {error && <p className="text-xs text-red-400 px-6 py-4">{error}</p>}

        {!loading && !error && (
          <table className="w-full border-collapse text-xs" style={{ minWidth: `${months.length * 90 + 260}px` }}>
            <thead>
              <tr className="bg-zinc-900 border-b border-zinc-800 sticky top-0 z-10">
                <th className="py-2 px-4 text-left text-[10px] text-zinc-600 uppercase tracking-wider font-medium w-56">
                  Category
                </th>
                {months.map((m) => (
                  <th key={m.month} className="py-2 px-2 text-right text-[10px] text-zinc-500 uppercase tracking-wider font-medium w-22">
                    {monthLabel(m.month)}
                  </th>
                ))}
                <th className="py-2 pl-2 pr-4 text-right text-[10px] text-zinc-400 uppercase tracking-wider font-semibold w-28">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row) => {
                const isSubtotal  = row.subtotal;
                const isHighlight = row.highlight;
                const rowCls = isHighlight
                  ? "border-t-2 border-zinc-600 bg-zinc-800/50"
                  : isSubtotal
                    ? "border-t border-zinc-700/60 bg-zinc-900/60"
                    : "border-t border-zinc-800/40 hover:bg-zinc-900/20";

                return (
                  <tr key={row.key} className={rowCls}>
                    <td className={`py-2 px-4 font-${isSubtotal || isHighlight ? "semibold" : "normal"} ${isHighlight ? "text-zinc-100" : isSubtotal ? "text-zinc-300" : "text-zinc-500"}`}>
                      {row.label}
                    </td>
                    {months.map((m) => {
                      const val = m[row.key] as number;
                      if (row.pending && val === 0) {
                        return (
                          <td key={m.month} className="py-2 px-2 text-right text-[10px] text-zinc-700 italic">
                            {months.indexOf(m) === 0 ? "pending" : "—"}
                          </td>
                        );
                      }
                      return (
                        <td key={m.month} className={`py-2 px-2 text-right font-mono tabular-nums ${isHighlight || isSubtotal ? "font-semibold" : ""}`}>
                          <MoneyCell cents={val} highlight={isHighlight} />
                        </td>
                      );
                    })}
                    <td className={`py-2 pl-2 pr-4 text-right font-mono tabular-nums ${isHighlight ? "text-sm font-bold" : "font-semibold"}`}>
                      {row.pending && (totals?.[row.key] as number) === 0
                        ? <span className="text-[10px] text-zinc-700 italic font-normal">Ramp not yet connected</span>
                        : <MoneyCell cents={(totals?.[row.key] as number) ?? 0} highlight={isHighlight} />
                      }
                    </td>
                  </tr>
                );
              })}

              {/* Financing / investing placeholder */}
              <tr className="border-t border-zinc-800/40">
                <td colSpan={months.length + 2} className="px-4 py-3 text-[10px] text-zinc-700">
                  Investing and financing activities not tracked. Operating outflows (Ramp card spend) pending Ramp integration.
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

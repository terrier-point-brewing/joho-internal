"use client";

import { formatCurrency } from "@/lib/format";

export type RowType = "data" | "subtotal" | "spacer" | "section";

export interface SalesRow {
  type:    RowType;
  label?:  string;
  key?:    string;
  format?: "usd" | "qty" | "bbl";
  indent?: boolean;
}

interface Props {
  rows:    SalesRow[];
  months:  string[];   // e.g. ["2026-01", "2026-02", ...]
  monthly: Record<string, Record<string, number>>;
  loading: boolean;
}

function fmtUsd(n: number) {
  if (n === 0) return <span className="text-zinc-700">—</span>;
  const neg = n < 0;
  const s = formatCurrency(Math.abs(n), 0);
  return <span className={neg ? "text-red-400" : undefined}>{neg ? `(${s})` : s}</span>;
}

function fmtQty(n: number) {
  if (n === 0) return <span className="text-zinc-700">—</span>;
  return <>{n.toLocaleString()}</>;
}

function fmtBbl(n: number) {
  if (n === 0) return <span className="text-zinc-700">—</span>;
  return <>{n.toFixed(2)}</>;
}

function fmtVal(n: number, format: "usd" | "qty" | "bbl" = "usd") {
  if (format === "qty") return fmtQty(n);
  if (format === "bbl") return fmtBbl(n);
  return fmtUsd(n);
}

// Short month label: "Jan", "Feb", etc.
function monthLabel(ym: string) {
  const [y, m] = ym.split("-");
  return new Date(Number(y), Number(m) - 1, 1).toLocaleString("en-US", { month: "short" });
}

export default function SalesTable({ rows, months, monthly, loading }: Props) {
  const MONTHS = months.slice(-12); // cap at 12

  // Column total (sum over all months) per key
  function colTotal(key: string, format: "usd" | "qty" | "bbl" = "usd") {
    const total = MONTHS.reduce((s, ym) => s + (monthly[ym]?.[key] ?? 0), 0);
    return fmtVal(total, format);
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="border-b border-zinc-800">
            <th className="sticky left-0 bg-zinc-950 px-4 py-2 text-left text-zinc-500 font-medium w-36 min-w-[144px] sm:w-52 sm:min-w-[208px]" />
            {MONTHS.map((ym) => (
              <th key={ym} className="px-3 py-2 text-right text-zinc-500 font-medium min-w-[80px]">
                {monthLabel(ym)}
              </th>
            ))}
            <th className="px-3 py-2 text-right text-zinc-400 font-semibold min-w-[88px] border-l border-zinc-800">
              Total
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            if (row.type === "spacer") {
              return <tr key={i} className="h-3"><td colSpan={MONTHS.length + 2} /></tr>;
            }

            if (row.type === "section") {
              return (
                <tr key={i}>
                  <td colSpan={MONTHS.length + 2}
                    className="sticky left-0 bg-zinc-950 px-4 pt-3 pb-1 text-zinc-500 uppercase tracking-wider text-[10px] font-semibold w-36 min-w-[144px] sm:w-52 sm:min-w-[208px]">
                    {row.label}
                  </td>
                </tr>
              );
            }

            const isSubtotal = row.type === "subtotal";
            const key = row.key ?? "";
            const fmt = row.format ?? "usd";

            return (
              <tr key={i} className={`border-t ${isSubtotal ? "border-zinc-700 bg-zinc-900/40" : "border-zinc-800/40 hover:bg-zinc-900/30"}`}>
                <td className={`sticky left-0 ${isSubtotal ? "bg-zinc-900" : "bg-zinc-950 hover:bg-zinc-900/30"} px-4 py-1.5 font-${isSubtotal ? "semibold" : "normal"} ${isSubtotal ? "text-zinc-200" : row.indent ? "text-zinc-500 pl-8" : "text-zinc-400"} w-36 min-w-[144px] sm:w-52 sm:min-w-[208px] max-w-[144px] sm:max-w-[208px] truncate`}>
                  {row.label}
                </td>
                {loading ? (
                  <td colSpan={MONTHS.length + 1} className="px-3 py-1.5 text-zinc-700 text-center">—</td>
                ) : (
                  <>
                    {MONTHS.map((ym) => {
                      const val = monthly[ym]?.[key] ?? 0;
                      return (
                        <td key={ym} className={`px-3 py-1.5 text-right tabular-nums font-mono ${isSubtotal ? "text-zinc-200 font-semibold" : "text-zinc-400"}`}>
                          {fmtVal(val, fmt)}
                        </td>
                      );
                    })}
                    <td className={`px-3 py-1.5 text-right tabular-nums font-mono border-l border-zinc-800 ${isSubtotal ? "text-amber-400 font-bold" : "text-zinc-500"}`}>
                      {colTotal(key, fmt)}
                    </td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

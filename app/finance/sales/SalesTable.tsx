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
  if (n === 0) return <span className="text-faint">—</span>;
  const neg = n < 0;
  const s = formatCurrency(Math.abs(n), 0);
  return <span className={neg ? "text-danger" : undefined}>{neg ? `(${s})` : s}</span>;
}

function fmtQty(n: number) {
  if (n === 0) return <span className="text-faint">—</span>;
  return <>{n.toLocaleString()}</>;
}

function fmtBbl(n: number) {
  if (n === 0) return <span className="text-faint">—</span>;
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
          <tr className="border-b border-line">
            <th className="sticky left-0 bg-canvas px-4 py-2 text-left text-muted font-medium w-36 min-w-[144px] sm:w-52 sm:min-w-[208px]" />
            {MONTHS.map((ym) => (
              <th key={ym} className="px-3 py-2 text-right text-muted font-medium min-w-[80px]">
                {monthLabel(ym)}
              </th>
            ))}
            <th className="px-3 py-2 text-right text-secondary font-semibold min-w-[88px] border-l border-line">
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
                    className="sticky left-0 bg-canvas px-4 pt-3 pb-1 text-muted uppercase tracking-wider text-xs font-semibold w-36 min-w-[144px] sm:w-52 sm:min-w-[208px]">
                    {row.label}
                  </td>
                </tr>
              );
            }

            const isSubtotal = row.type === "subtotal";
            const key = row.key ?? "";
            const fmt = row.format ?? "usd";

            return (
              <tr key={i} className={`border-t ${isSubtotal ? "border-line-strong bg-surface/40" : "border-line/40 hover:bg-surface/30"}`}>
                <td className={`sticky left-0 ${isSubtotal ? "bg-surface" : "bg-canvas hover:bg-surface/30"} px-4 py-1.5 font-${isSubtotal ? "semibold" : "normal"} ${isSubtotal ? "text-strong" : row.indent ? "text-muted pl-8" : "text-secondary"} w-36 min-w-[144px] sm:w-52 sm:min-w-[208px] max-w-[144px] sm:max-w-[208px] truncate`}>
                  {row.label}
                </td>
                {loading ? (
                  <td colSpan={MONTHS.length + 1} className="px-3 py-1.5 text-faint text-center">—</td>
                ) : (
                  <>
                    {MONTHS.map((ym) => {
                      const val = monthly[ym]?.[key] ?? 0;
                      return (
                        <td key={ym} className={`px-3 py-1.5 text-right tabular-nums font-mono ${isSubtotal ? "text-strong font-semibold" : "text-secondary"}`}>
                          {fmtVal(val, fmt)}
                        </td>
                      );
                    })}
                    <td className={`px-3 py-1.5 text-right tabular-nums font-mono border-l border-line ${isSubtotal ? "text-accent font-bold" : "text-muted"}`}>
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

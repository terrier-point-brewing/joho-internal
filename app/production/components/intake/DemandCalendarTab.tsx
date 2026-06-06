"use client";

import { useQuery } from "@tanstack/react-query";
import { format, parseISO } from "date-fns";
import type { DemandRow, DemandWeek } from "../../lib/demandCalendar";
import { fetchJson } from "../../hooks/queries";

function cellBg(eow: number, rowStatus: DemandRow["status"], week: DemandWeek, leadTime: number, stockoutDate: string | null): string {
  // Individual cell coloring: red/yellow once the EOW balance triggers thresholds.
  if (eow <= 0) return "bg-red-900/60 text-red-200";
  if (!stockoutDate || leadTime === 0) return "";
  // Days from this week's start to stockout
  const weekDate = parseISO(week.weekStart);
  const stockout = parseISO(stockoutDate);
  const days = Math.ceil((stockout.getTime() - weekDate.getTime()) / 86400000);
  if (days <= leadTime) return "bg-red-900/40 text-red-300";
  if (days <= leadTime * 1.5) return "bg-amber-900/40 text-amber-300";
  return "";
}

function StatusBadge({ status }: { status: DemandRow["status"] }) {
  const map = {
    green: "bg-green-900/50 text-green-400 border-green-800",
    yellow: "bg-amber-900/50 text-amber-400 border-amber-800",
    red: "bg-red-900/50 text-red-400 border-red-800",
  };
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded border font-medium ${map[status]}`}>
      {status === "green" ? "OK" : status === "yellow" ? "Warn" : "Alert"}
    </span>
  );
}

export default function DemandCalendarTab() {
  const { data: rows = [], isLoading: loading, error, refetch } = useQuery({
    queryKey: ["production", "demand-calendar"],
    queryFn: () => fetchJson<DemandRow[]>("/api/production/demand-calendar"),
  });
  const load = () => refetch();

  if (loading) return <p className="text-zinc-600 text-sm py-10 text-center">Loading…</p>;
  if (error) return <p className="text-sm text-red-400 py-6">{error instanceof Error ? error.message : "Error"}</p>;
  if (rows.length === 0) return (
    <div className="py-16 text-center space-y-2">
      <p className="text-zinc-600 text-sm">No demand data yet.</p>
      <p className="text-xs text-zinc-700">Add distribution allocations, contract requests, or safety stock floors to see projections.</p>
    </div>
  );

  // Derive week headers from first row
  const weekHeaders = rows[0]?.weeks.map((w) => format(parseISO(w.weekStart), "MMM d")) ?? [];

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <p className="text-sm text-zinc-500">
          12-week BBL projection per style × packaging. Color: <span className="text-red-400">red</span> = within 1× lead time of stockout, <span className="text-amber-400">yellow</span> = within 1.5×.
        </p>
        <button onClick={load} className="px-3 py-1.5 border border-zinc-700 hover:border-zinc-500 text-zinc-300 text-sm rounded transition-colors">Refresh</button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-zinc-800">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-zinc-800 bg-zinc-900/60">
              <th className="sticky left-0 z-10 bg-zinc-900/95 px-4 py-2.5 text-left font-medium text-zinc-500 whitespace-nowrap min-w-[140px]">Style</th>
              <th className="sticky left-[140px] z-10 bg-zinc-900/95 px-3 py-2.5 text-left font-medium text-zinc-500 whitespace-nowrap w-12">Pkg</th>
              <th className="px-3 py-2.5 text-right font-medium text-zinc-500 whitespace-nowrap">Now (BBL)</th>
              <th className="px-3 py-2.5 text-right font-medium text-zinc-500 whitespace-nowrap">Floor</th>
              <th className="px-3 py-2.5 text-center font-medium text-zinc-500 whitespace-nowrap">Lead</th>
              <th className="px-3 py-2.5 text-center font-medium text-zinc-500 whitespace-nowrap">Status</th>
              {weekHeaders.map((h, i) => (
                <th key={i} className="px-3 py-2.5 text-right font-medium text-zinc-500 whitespace-nowrap min-w-[68px]">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={`${row.recipe_id}:${row.packaging}`}
                className={`border-b border-zinc-800/60 ${ri % 2 !== 0 ? "bg-zinc-900/30" : ""}`}>
                <td className={`sticky left-0 z-10 px-4 py-2 font-medium text-zinc-100 whitespace-nowrap ${ri % 2 !== 0 ? "bg-zinc-900/80" : "bg-zinc-950/80"}`}>
                  {row.style}
                </td>
                <td className={`sticky left-[140px] z-10 px-3 py-2 text-zinc-500 capitalize ${ri % 2 !== 0 ? "bg-zinc-900/80" : "bg-zinc-950/80"}`}>
                  {row.packaging}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-200">{row.current_bbl.toFixed(2)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-500">{row.safety_floor_bbl > 0 ? row.safety_floor_bbl.toFixed(2) : "—"}</td>
                <td className="px-3 py-2 text-center text-zinc-500">{row.lead_time_days > 0 ? `${row.lead_time_days}d` : "—"}</td>
                <td className="px-3 py-2 text-center"><StatusBadge status={row.status} /></td>
                {row.weeks.map((w, wi) => {
                  const bg = cellBg(w.projected_eow_bbl, row.status, w, row.lead_time_days, row.stockout_date);
                  return (
                    <td key={wi}
                      title={`Inflow: +${w.inflow_bbl.toFixed(2)} BBL\nOutflow: -${w.outflow_bbl.toFixed(2)} BBL\nEOW: ${w.projected_eow_bbl.toFixed(2)} BBL`}
                      className={`px-3 py-2 text-right tabular-nums whitespace-nowrap rounded-sm ${bg || "text-zinc-400"}`}>
                      {w.projected_eow_bbl.toFixed(2)}
                      {(w.inflow_bbl > 0 || w.outflow_bbl > 0) && (
                        <div className="text-zinc-600 text-[10px] leading-none mt-0.5">
                          {w.inflow_bbl > 0 && <span className="text-green-700">+{w.inflow_bbl.toFixed(1)}</span>}
                          {w.inflow_bbl > 0 && w.outflow_bbl > 0 && " "}
                          {w.outflow_bbl > 0 && <span className="text-red-700">-{w.outflow_bbl.toFixed(1)}</span>}
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 mt-3 text-xs text-zinc-600">
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-red-900/60 inline-block" /> Stockout</span>
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-red-900/40 inline-block" /> Within 1× lead time</span>
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-amber-900/40 inline-block" /> Within 1.5× lead time</span>
        <span className="text-zinc-700">Cell tooltip shows inflow/outflow breakdown. +green = inflow, -red = outflow.</span>
      </div>
    </div>
  );
}

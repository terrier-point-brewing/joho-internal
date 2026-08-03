"use client";

import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { format, parseISO } from "date-fns";
import type { DemandRow, DemandWeek } from "../../lib/demandCalendar";
import { fetchJson } from "../../hooks/queries";

function rowUrgency(row: DemandRow): "red" | "amber" | "none" {
  if (row.status === "red") return "red";
  if (row.status === "yellow") return "amber";
  return "none";
}

function cellTextColor(eow: number, week: DemandWeek, leadTime: number, stockoutDate: string | null): string {
  if (eow <= 0) return "text-danger font-semibold";
  if (!stockoutDate || leadTime === 0) return "text-secondary";
  const days = Math.ceil((parseISO(stockoutDate).getTime() - parseISO(week.weekStart).getTime()) / 86400000);
  if (days <= leadTime) return "text-danger";
  if (days <= leadTime * 1.5) return "text-[var(--cat-amber-fg)]";
  return "text-secondary";
}

function cellTitle(w: DemandWeek): string {
  const lines: string[] = [`EOW: ${w.projected_eow_bbl.toFixed(2)} BBL`];
  if (w.inflow_bbl > 0) lines.push(`  + Inflow: ${w.inflow_bbl.toFixed(2)} BBL`);
  if (w.taproom_outflow_bbl > 0) lines.push(`  − Taproom: ${w.taproom_outflow_bbl.toFixed(2)} BBL`);
  if (w.distribution_outflow_bbl > 0) lines.push(`  − Distribution: ${w.distribution_outflow_bbl.toFixed(2)} BBL`);
  if (w.contract_outflow_bbl > 0) lines.push(`  − Contract: ${w.contract_outflow_bbl.toFixed(2)} BBL`);
  return lines.join("\n");
}

function StatusDot({ status }: { status: DemandRow["status"] }) {
  const cls = status === "red" ? "bg-danger" : status === "yellow" ? "bg-accent" : "bg-success/60";
  const label = status === "red" ? "Alert" : status === "yellow" ? "Warn" : "OK";
  return (
    <span className="flex items-center gap-1.5">
      <span className={`inline-block w-2 h-2 rounded-full ${cls}`} />
      <span className={`text-xs ${status === "red" ? "text-danger" : status === "yellow" ? "text-[var(--cat-amber-fg)]" : "text-muted"}`}>{label}</span>
    </span>
  );
}

const CHANNEL_ROWS: {
  key: "taproom_outflow_bbl" | "distribution_outflow_bbl" | "contract_outflow_bbl";
  label: string;
  dotCls: string;
}[] = [
  { key: "taproom_outflow_bbl",      label: "Taproom",      dotCls: "bg-[var(--cat-emerald-fg)]" },
  { key: "distribution_outflow_bbl", label: "Distribution", dotCls: "bg-[var(--cat-blue-fg)]"  },
  { key: "contract_outflow_bbl",     label: "Contract",     dotCls: "bg-[var(--cat-purple-fg)]" },
];

function fmtOutflow(val: number): string {
  if (val <= 0) return "—";
  return val.toFixed(2);
}

export default function DemandCalendarTab() {
  const { data: rows = [], isLoading: loading, error, refetch } = useQuery({
    queryKey: queryKeys.production.demandCalendar(),
    queryFn: () => fetchJson<DemandRow[]>("/api/production/demand-calendar"),
  });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggle(recipeId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(recipeId)) next.delete(recipeId);
      else next.add(recipeId);
      return next;
    });
  }

  if (loading) return <p className="text-faint text-sm py-10 text-center">Loading…</p>;
  if (error) return <p className="text-sm text-danger py-6">{error instanceof Error ? error.message : "Error"}</p>;
  if (rows.length === 0) return (
    <div className="py-16 text-center space-y-2">
      <p className="text-faint text-sm">No demand data yet.</p>
      <p className="text-xs text-disabled">Add distribution allocations, contract requests, or link recipes to Square for taproom sell-through.</p>
    </div>
  );

  const weekHeaders = rows[0]?.weeks.map((w) => format(parseISO(w.weekStart), "MMM d")) ?? [];
  const NUM_FIXED = 6; // Recipe, Now, Floor, Tap/wk, Lead, Status

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <p className="text-sm text-muted">
          12-week cold storage BBL projection per recipe. Click a recipe row to see per-channel breakdown.
        </p>
        <button onClick={() => refetch()} className="btn-secondary">
          Refresh
        </button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-line bg-surface/40 text-left">
              <th className="sticky left-0 z-10 bg-surface/95 px-4 py-3 text-left font-medium text-muted whitespace-nowrap min-w-[200px]">Recipe</th>
              <th className="px-3 py-3 text-right font-medium text-muted whitespace-nowrap">Now (bbl)</th>
              <th className="px-3 py-3 text-right font-medium text-muted whitespace-nowrap">Floor (bbl)</th>
              <th className="px-3 py-3 text-right font-medium text-muted whitespace-nowrap">Tap/wk (bbl)</th>
              <th className="px-3 py-3 text-center font-medium text-muted whitespace-nowrap">Lead</th>
              <th className="px-3 py-3 font-medium text-muted whitespace-nowrap">Status</th>
              {weekHeaders.map((h, i) => (
                <th key={i} className="px-3 py-3 text-right font-medium text-muted whitespace-nowrap min-w-[60px]">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line-strong/50">
            {rows.map((row) => {
              const urgency = rowUrgency(row);
              const borderCls = urgency === "red" ? "border-l-2 border-l-danger" : urgency === "amber" ? "border-l-2 border-l-accent" : "border-l-2 border-l-transparent";
              const isExpanded = expanded.has(row.recipe_id);

              return (
                <React.Fragment key={row.recipe_id}>
                  {/* Recipe row */}
                  <tr className={`${borderCls} cursor-pointer hover:bg-surface/30`}
                    onClick={() => toggle(row.recipe_id)}>
                    <td className="sticky left-0 z-10 bg-canvas px-4 py-2.5 font-medium text-primary whitespace-nowrap">
                      <span className="flex items-center gap-2">
                        <span className={`text-faint text-[10px] transition-transform ${isExpanded ? "rotate-90" : ""}`}>▶</span>
                        {row.style}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-body">{row.current_bbl.toFixed(2)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-faint">{row.safety_floor_bbl > 0 ? row.safety_floor_bbl.toFixed(2) : "—"}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-faint">
                      {row.taproom_bbl_per_week > 0 ? row.taproom_bbl_per_week.toFixed(2) : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-center text-faint">{row.lead_time_days > 0 ? `${row.lead_time_days}d` : "—"}</td>
                    <td className="px-3 py-2.5"><StatusDot status={row.status} /></td>
                    {row.weeks.map((w, wi) => {
                      const textCls = cellTextColor(w.projected_eow_bbl, w, row.lead_time_days, row.stockout_date);
                      return (
                        <td key={wi} title={cellTitle(w)}
                          className={`px-3 py-2.5 text-right tabular-nums whitespace-nowrap ${textCls}`}>
                          {w.projected_eow_bbl.toFixed(2)}
                        </td>
                      );
                    })}
                  </tr>

                  {/* Channel sub-rows (expanded) */}
                  {isExpanded && CHANNEL_ROWS.map((ch) => {
                    const hasAnyData = row.weeks.some((w) => w[ch.key] > 0);
                    return (
                      <tr key={`${row.recipe_id}-${ch.key}`}
                        className="bg-surface/40 border-l-2 border-l-transparent">
                        <td className="sticky left-0 z-10 bg-surface/60 px-4 py-1.5 whitespace-nowrap">
                          <span className="flex items-center gap-2 pl-5">
                            <span className={`inline-block w-1.5 h-1.5 rounded-full ${ch.dotCls}`} />
                            <span className="text-muted">{ch.label}</span>
                          </span>
                        </td>
                        {/* Fixed blank columns */}
                        {Array.from({ length: NUM_FIXED - 1 }).map((_, ci) => (
                          <td key={ci} className="px-3 py-1.5" />
                        ))}
                        {/* Weekly outflow cells */}
                        {row.weeks.map((w, wi) => {
                          const val = w[ch.key];
                          return (
                            <td key={wi}
                              className={`px-3 py-1.5 text-right tabular-nums whitespace-nowrap ${val > 0 ? "text-muted" : "text-disabled"}`}>
                              {hasAnyData ? fmtOutflow(val) : "—"}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-5 mt-3 text-xs text-faint">
        <span className="flex items-center gap-1.5"><span className="w-0.5 h-4 bg-danger rounded inline-block" /> Alert — within 1× lead time of stockout</span>
        <span className="flex items-center gap-1.5"><span className="w-0.5 h-4 bg-accent rounded inline-block" /> Warn — within 1.5× lead time</span>
        <span className="text-disabled">Hover cells to see inflow / outflow breakdown · Click recipe to expand channel breakdown</span>
      </div>
    </div>
  );
}

"use client";

import React, { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { format, parseISO } from "date-fns";
import { queryKeys } from "@/lib/query-keys";
import { fmtDateLong } from "@/lib/utils/formatting";
import { fetchJson } from "../../hooks/queries";
import Banner from "@/app/components/ui/Banner";
import Badge from "@/app/components/ui/Badge";
import ButtonGroup from "@/app/components/ButtonGroup";
import type { Tone } from "@/app/components/ui/tone";
import type { PlanRow } from "@/lib/production/intakeDemand.server";
import type { DemandWeek } from "../../lib/demandCalendar";

/**
 * Intake's home: one row per beer, one question — does it need a batch?
 *
 * Everything on the row comes from the same projection the schedule form uses
 * (lib/production/intakeDemand.server), so the list and the form cannot disagree.
 */

type View = "action" | "all";

/** What the brewer should do about this beer, in three words or fewer. */
function verdict(row: PlanRow): { label: string; tone: Tone; needsBatch: boolean } {
  if (row.is_retired) return { label: "Retired", tone: "neutral", needsBatch: false };
  if (row.status === "red") return { label: "Brew now", tone: "danger", needsBatch: true };
  if (row.status === "yellow") return { label: "Brew soon", tone: "accent", needsBatch: true };
  if (row.uncovered_bbl >= 0.1) return { label: "Needs a batch", tone: "accent", needsBatch: true };
  return { label: "OK", tone: "success", needsBatch: false };
}

const CHANNELS: { key: keyof DemandWeek & `${string}_outflow_bbl`; label: string }[] = [
  { key: "taproom_outflow_bbl", label: "Taproom" },
  { key: "distribution_outflow_bbl", label: "Distribution" },
  { key: "wholesale_outflow_bbl", label: "Wholesale" },
  { key: "contract_outflow_bbl", label: "Contract" },
];

const bbl = (n: number) => (n > 0 ? n.toFixed(1) : "—");

export default function PlanTab({ onSchedule }: { onSchedule: (recipeId: string | null) => void }) {
  const qc = useQueryClient();
  // isPending, not isLoading: a paused retry must not fall through to "nothing to do".
  const { data, isPending, error, refetch } = useQuery({
    queryKey: queryKeys.production.demandCalendar(),
    queryFn: () => fetchJson<{ rows: PlanRow[]; warnings: string[] }>("/api/production/demand-calendar"),
    staleTime: 5 * 60 * 1000, // Square-backed: don't refetch on every tab switch
  });
  const [view, setView] = useState<View>("action");
  const [open, setOpen] = useState<string | null>(null);
  const [retiring, setRetiring] = useState<string | null>(null);

  async function toggleRetire(row: PlanRow) {
    setRetiring(row.recipe_id);
    try {
      const res = await fetch("/api/production/taproom-recipe-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipe_id: row.recipe_id, is_retired: !row.is_retired }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Could not save");
      await qc.invalidateQueries({ queryKey: queryKeys.production.demandCalendar() });
    } catch (e) {
      alert(e instanceof Error ? e.message : "Could not save");
    } finally {
      setRetiring(null);
    }
  }

  if (isPending) return <p className="text-faint text-sm py-10 text-center">Loading stock, sales and commitments…</p>;
  if (error) return <Banner>{error instanceof Error ? error.message : "Could not load the plan."}</Banner>;

  const rows = data?.rows ?? [];
  const rank = { red: 0, yellow: 1, green: 2 } as const;
  const sorted = [...rows].sort((a, b) =>
    Number(a.is_retired) - Number(b.is_retired)
    || Number(verdict(b).needsBatch) - Number(verdict(a).needsBatch)
    || rank[a.status] - rank[b.status]
    || (a.stockout_date ?? "9999").localeCompare(b.stockout_date ?? "9999")
    || a.style.localeCompare(b.style));
  const actionRows = sorted.filter((r) => verdict(r).needsBatch);
  const shown = view === "action" ? actionRows : sorted;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <ButtonGroup<View>
          tabs={[{ key: "action", label: `Needs a batch (${actionRows.length})` }, { key: "all", label: `All beers (${rows.length})` }]}
          activeKey={view}
          onSelect={setView}
        />
        <div className="flex items-center gap-2">
          <button onClick={() => refetch()} className="btn-secondary">Refresh</button>
          <button onClick={() => onSchedule(null)} className="btn-primary">+ Schedule batch</button>
        </div>
      </div>

      {(data?.warnings ?? []).map((w) => <Banner key={w} className="mb-3">{w}</Banner>)}

      {shown.length === 0 ? (
        <p className="text-faint text-sm py-10 text-center">
          {view === "action" ? "Nothing needs brewing right now." : "No beers with stock, sales or commitments yet."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface/50 text-left text-xs text-muted">
                <th className="px-4 py-2.5 font-medium">Beer</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium text-right whitespace-nowrap">On hand (bbl)</th>
                <th className="px-4 py-2.5 font-medium text-right whitespace-nowrap">Taproom / wk</th>
                <th className="px-4 py-2.5 font-medium text-right whitespace-nowrap">Owed to partners</th>
                <th className="px-4 py-2.5 font-medium whitespace-nowrap">Runs out</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {shown.map((row, i) => {
                const v = verdict(row);
                const isOpen = open === row.recipe_id;
                return (
                  <React.Fragment key={row.recipe_id}>
                    <tr
                      className={`border-b border-line/60 cursor-pointer hover:bg-surface/40 ${i % 2 !== 0 ? "bg-surface/30" : ""}`}
                      onClick={() => setOpen(isOpen ? null : row.recipe_id)}
                    >
                      <td className="px-4 py-2.5 font-medium text-primary">
                        <span className={`inline-block text-faint text-[10px] mr-2 transition-transform ${isOpen ? "rotate-90" : ""}`}>▶</span>
                        {row.style}
                      </td>
                      <td className="px-4 py-2.5"><Badge tone={v.tone}>{v.label}</Badge></td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-body">{row.current_bbl.toFixed(1)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-body">{bbl(row.taproom_bbl_per_week)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-body">
                        {bbl(row.owed_bbl)}
                        {row.uncovered_bbl >= 0.1 && <span className="block text-xs text-accent-soft">{row.uncovered_bbl.toFixed(1)} with no batch</span>}
                      </td>
                      <td className={`px-4 py-2.5 whitespace-nowrap ${row.status === "red" ? "text-danger" : "text-secondary"}`}>
                        {row.stockout_date ? `week of ${fmtDateLong(row.stockout_date)}` : "not in 12 weeks"}
                      </td>
                      <td className="px-4 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                        {!row.is_retired && (
                          <button onClick={() => onSchedule(row.recipe_id)} className={v.needsBatch ? "btn-primary btn-xxs" : "btn-secondary btn-xxs"}>
                            Schedule batch
                          </button>
                        )}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="border-b border-line/60 bg-surface/40">
                        <td colSpan={7} className="px-4 py-3">
                          <WeekDetail row={row} />
                          <div className="flex items-center justify-between mt-2 text-xs text-faint">
                            <span>Lead time {row.lead_time_days > 0 ? `${row.lead_time_days} days` : "not set on the recipe"}.</span>
                            <button onClick={() => toggleRetire(row)} disabled={retiring === row.recipe_id} className="btn-secondary btn-xxs">
                              {retiring === row.recipe_id ? "…" : row.is_retired ? "Bring back" : "Retire — stop planning this beer"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** The 12-week projection for one beer: stock at the end of each week, by channel. */
function WeekDetail({ row }: { row: PlanRow }) {
  const channels = CHANNELS.filter((c) => row.weeks.some((w) => w[c.key] > 0));
  return (
    <div className="overflow-x-auto">
      <table className="text-xs w-full">
        <thead>
          <tr className="text-muted">
            <th className="text-left font-medium pr-3 py-1 whitespace-nowrap">Week of</th>
            {row.weeks.map((w) => <th key={w.weekStart} className="text-right font-medium px-2 py-1 whitespace-nowrap">{format(parseISO(w.weekStart), "MMM d")}</th>)}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="pr-3 py-1 text-secondary whitespace-nowrap">Brewed in</td>
            {row.weeks.map((w) => <td key={w.weekStart} className={`text-right px-2 py-1 tabular-nums ${w.inflow_bbl > 0 ? "text-success" : "text-disabled"}`}>{w.inflow_bbl > 0 ? `+${w.inflow_bbl.toFixed(1)}` : "—"}</td>)}
          </tr>
          {channels.map((c) => (
            <tr key={c.key}>
              <td className="pr-3 py-1 text-secondary whitespace-nowrap">{c.label}</td>
              {row.weeks.map((w) => <td key={w.weekStart} className={`text-right px-2 py-1 tabular-nums ${w[c.key] > 0 ? "text-muted" : "text-disabled"}`}>{w[c.key] > 0 ? `−${w[c.key].toFixed(1)}` : "—"}</td>)}
            </tr>
          ))}
          <tr className="border-t border-line">
            <td className="pr-3 py-1 font-medium text-primary whitespace-nowrap">Left at week end</td>
            {row.weeks.map((w) => (
              <td key={w.weekStart} className={`text-right px-2 py-1 tabular-nums font-medium ${w.projected_eow_bbl < 0 ? "text-danger" : "text-body"}`}>
                {w.projected_eow_bbl.toFixed(1)}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

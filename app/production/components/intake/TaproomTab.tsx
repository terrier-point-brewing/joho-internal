"use client";

import React, { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { Recipe } from "../../types";
import { fmtDateLong } from "@/lib/utils/formatting";
import { fetchJson } from "../../hooks/queries";
interface TaproomRow {
  recipe_id: string;
  style: string;
  lead_time_days: number;
  current_bbl: number;
  daily_sell_through_bbl: number;
  min_threshold_bbl: number;
  forecast_threshold_date: string | null;
  forecast_stockout_date: string | null;
  needed_bbl: number;
  brew_by_date: string | null;
  history_bbl: { week: string; bbl: number | null }[];
  is_retired: boolean;
  packaging_breakdown: {
    link_id: string;
    packaging: string;
    packaging_item_name: string | null;
    variation_name: string | null;
    item_name: string | null;
    volume_fl_oz: number | null;
    current_qty: number;
    current_bbl: number;
    daily_sell_through_units: number;
    daily_sell_through_bbl: number;
  }[];
}

function BblSparkline({ history }: { history: { week: string; bbl: number | null }[] }) {
  const vals = history.map((h) => h.bbl).filter((q): q is number => q != null);
  if (vals.length === 0) return <span className="text-faint text-xs">no data</span>;
  const max = Math.max(...vals, 0.1);
  return (
    <span className="inline-flex items-end gap-0.5 h-6">
      {history.map((h, i) => (
        <span key={i} title={`${h.week}: ${h.bbl != null ? h.bbl.toFixed(2) + " BBL" : "—"}`}
          className="w-1.5 bg-accent-emphasis/70 rounded-sm"
          style={{ height: h.bbl != null ? `${Math.max((h.bbl / max) * 24, 2)}px` : "2px", opacity: h.bbl != null ? 1 : 0.3 }} />
      ))}
    </span>
  );
}

function urgencyColor(row: TaproomRow): "red" | "amber" | "green" | "none" {
  if (row.is_retired) return "none";
  if (!row.forecast_stockout_date || row.daily_sell_through_bbl === 0) return "none";
  const daysToStockout = Math.ceil((new Date(row.forecast_stockout_date).getTime() - Date.now()) / 86400000);
  if (daysToStockout <= row.lead_time_days) return "red";
  if (daysToStockout <= row.lead_time_days * 1.5) return "amber";
  return "green";
}

export default function TaproomTab({ recipes }: { recipes: Recipe[] }) {
  const qc = useQueryClient();
  const { data: rows = [], isLoading: loading, error } = useQuery({
    queryKey: queryKeys.production.taproomInventory(),
    queryFn: () => fetchJson<TaproomRow[]>("/api/production/taproom-inventory"),
    staleTime: 5 * 60 * 1000, // Square data: treat as fresh for 5 min, avoids re-fetch on tab switch
  });
  const loadInventory = () => qc.invalidateQueries({ queryKey: queryKeys.production.taproomInventory() });
  const err = error instanceof Error ? error.message : null;
  const [retiring, setRetiring] = useState<string | null>(null);

  async function toggleRetire(recipeId: string, currentlyRetired: boolean) {
    setRetiring(recipeId);
    try {
      await fetch("/api/production/taproom-recipe-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipe_id: recipeId, is_retired: !currentlyRetired }),
      });
      await loadInventory();
    } finally {
      setRetiring(null);
    }
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <p className="text-sm text-muted">
          Taproom sell-through by recipe — BBL on hand, daily rate, and brew-by date to avoid stockout.
        </p>
        <button onClick={() => loadInventory()}
          className="btn-secondary">
          Refresh
        </button>
      </div>

      {err && <p className="text-sm text-danger mb-3">{err}</p>}
      {loading ? (
        <p className="text-faint text-sm py-10 text-center">Loading inventory from Square…</p>
      ) : rows.length === 0 ? (
        <p className="text-faint text-sm py-10 text-center">No styles linked to Square yet. Visit Square Mappings in Settings to link recipes.</p>
      ) : (
        <div className="rounded-lg border border-line overflow-hidden">
          <div className="overflow-x-auto">
          {rows.map((row, i) => {
            const color = urgencyColor(row);
            const belowThreshold = !row.is_retired && row.min_threshold_bbl > 0 && row.current_bbl <= row.min_threshold_bbl;

            return (
              <div key={row.recipe_id} className={`min-w-[700px] ${i > 0 ? "border-t border-line" : ""}`}>
                <div className={`flex items-center gap-4 px-4 py-3 ${i % 2 !== 0 ? "bg-surface/30" : ""}`}>
                  {/* Urgency dot */}
                  <div className={`w-2 h-2 rounded-full shrink-0 ${
                    color === "red" ? "bg-danger-emphasis" :
                    color === "amber" ? "bg-accent-emphasis" :
                    color === "green" ? "bg-success-emphasis/50" :
                    "bg-surface-high"
                  }`} />

                  {/* Style name */}
                  <div className="flex items-center gap-2 w-[180px] shrink-0">
                    <span className="font-semibold text-primary truncate">{row.style}</span>
                    {row.is_retired && (
                      <span className="text-[10px] px-1.5 py-px rounded border border-line-strong text-muted whitespace-nowrap shrink-0">Retired</span>
                    )}
                  </div>

                  {/* BBL on hand */}
                  <div className="flex flex-col w-[90px] shrink-0">
                    <span className={`text-sm tabular-nums font-medium ${belowThreshold ? "text-danger" : "text-strong"}`}>
                      {row.current_bbl.toFixed(2)} BBL
                    </span>
                    <span className="text-xs text-faint">on hand</span>
                  </div>

                  {/* Sell-through */}
                  <div className="flex flex-col w-[90px] shrink-0">
                    <span className="text-sm tabular-nums text-body">
                      {row.daily_sell_through_bbl > 0 ? row.daily_sell_through_bbl.toFixed(2) : "—"}
                    </span>
                    <span className="text-xs text-faint">BBL/day</span>
                  </div>

                  {/* 4-week sparkline */}
                  <div className="w-[60px] shrink-0">
                    <BblSparkline history={row.history_bbl} />
                  </div>

                  {/* Stockout date */}
                  <div className="flex flex-col w-[110px] shrink-0">
                    {!row.is_retired && row.forecast_stockout_date ? (
                      <>
                        <span className={`text-sm ${color === "red" ? "text-danger" : color === "amber" ? "text-accent" : "text-secondary"}`}>
                          {fmtDateLong(row.forecast_stockout_date)}
                        </span>
                        <span className="text-xs text-faint">stockout</span>
                      </>
                    ) : row.is_retired ? (
                      <span className="text-faint text-sm italic">retired</span>
                    ) : (
                      <span className="text-faint text-sm">no stockout</span>
                    )}
                  </div>

                  {/* Brew-by callout or retire action */}
                  <div className="ml-auto flex items-center gap-2 shrink-0">
                    {!row.is_retired && row.needed_bbl > 0 && (
                      <div className={`flex items-center gap-2 px-3 py-1.5 rounded border text-xs ${
                        color === "red"
                          ? "border-danger-border/60 bg-danger-surface/30 text-danger"
                          : color === "amber"
                          ? "border-accent-border/60 bg-accent-muted/30 text-accent-soft"
                          : "border-line-strong/60 bg-surface-mid/30 text-secondary"
                      }`}>
                        <span>Brew <span className="font-semibold tabular-nums">{row.needed_bbl.toFixed(1)} BBL</span></span>
                        {row.brew_by_date && (
                          <span className="text-muted">by {fmtDateLong(row.brew_by_date)}</span>
                        )}
                      </div>
                    )}
                    <button
                      onClick={() => toggleRetire(row.recipe_id, row.is_retired)}
                      disabled={retiring === row.recipe_id}
                      className="btn-secondary btn-xxs"
                    >
                      {retiring === row.recipe_id ? "…" : row.is_retired ? "Unretire" : "Retire"}
                    </button>
                  </div>
                </div>

              </div>
            );
          })}
          </div>
        </div>
      )}

    </div>
  );
}

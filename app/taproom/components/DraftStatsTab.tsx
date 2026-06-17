"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import type { Recipe } from "../../production/types";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer, Cell,
} from "recharts";
import { SquareLinkManager, LinkRow } from "../../production/components/SquareLinkManager";
import { fetchJson } from "../../production/hooks/queries";

// ─── Types ────────────────────────────────────────────────────────────────────

interface TapMetrics {
  current_fl_oz: number;
  current_bbl: number;
  daily_fl_oz: number;
  daily_bbl: number;
  is_retired: boolean;
}

interface TapRow {
  tap_number: number;
  recipe_id: string | null;
  label: string | null;
  beer_name: string | null;
  metrics: TapMetrics | null;
}

interface KegEvent {
  date: string;
  shrinkage_fl_oz: number;
  shrinkage_pct: number;
}

interface ShrinkageItem {
  recipe_id: string;
  beer_name: string;
  events: KegEvent[];
  avg_shrinkage_fl_oz: number;
  avg_shrinkage_pct: number;
  keg_count: number;
}

interface DraftStatsData {
  tap_count: number;
  taps: TapRow[];
  shrinkage_by_recipe: ShrinkageItem[];
}

interface TapConfig {
  tap_count: number;
  taps: { tap_number: number; recipe_id: string | null; label: string | null; recipes?: { beer_name: string } | null }[];
}

interface RecipeOption {
  id: string;
  beer_name: string;
}

const RECIPE_COLORS = [
  "#f59e0b", "#60a5fa", "#34d399", "#f87171", "#a78bfa",
  "#fb923c", "#38bdf8", "#4ade80", "#e879f9", "#facc15",
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function daysUntilEmpty(flOz: number, dailyFlOz: number) {
  if (dailyFlOz <= 0) return null;
  return Math.floor(flOz / dailyFlOz);
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function DraftStatsTab() {
  const qc = useQueryClient();

  const { data: stats, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.taproom.draftStats(),
    queryFn:  () => fetchJson<DraftStatsData>("/api/taproom/draft-stats"),
    staleTime: 5 * 60_000,
  });

  const { data: tapConfig, refetch: refetchConfig } = useQuery({
    queryKey: queryKeys.taproom.tapConfig(),
    queryFn:  () => fetchJson<TapConfig>("/api/taproom/tap-config"),
    staleTime: 60_000,
  });

  // Draft-only Square links (for recipe selector filter)
  const { data: links = [] } = useQuery({
    queryKey: queryKeys.production.recipeSquareLinks(),
    queryFn:  () => fetchJson<LinkRow[]>("/api/production/recipe-square-links"),
    staleTime: 5 * 60_000,
  });

  // Recipes with at least one draft link
  const draftRecipeIds = new Set(links.filter((l) => l.packaging === "draft").map((l) => l.recipe_id));

  const [showLinks, setShowLinks] = useState(false);
  const [editingTaps, setEditingTaps] = useState(false);
  const [tapCountInput, setTapCountInput] = useState("");
  const [tapEdits, setTapEdits] = useState<Record<number, { recipe_id: string; label: string }>>({});
  const [saving, setSaving] = useState(false);
  const [retiringSaving, setRetiringSaving] = useState<string | null>(null);

  const err = error instanceof Error ? error.message : null;
  const shrinkageDays = 90;

  // Flat list of recipes with draft links (for tap assignment dropdown)
  const draftRecipes: RecipeOption[] = links
    .filter((l) => l.packaging === "draft" && l.recipes?.beer_name)
    .reduce<RecipeOption[]>((acc, l) => {
      if (!acc.find((r) => r.id === l.recipe_id)) {
        acc.push({ id: l.recipe_id, beer_name: l.recipes!.beer_name! });
      }
      return acc;
    }, [])
    .sort((a, b) => a.beer_name.localeCompare(b.beer_name));

  function startEditTaps() {
    setTapCountInput(String(stats?.tap_count ?? tapConfig?.tap_count ?? 8));
    const edits: Record<number, { recipe_id: string; label: string }> = {};
    const src = stats?.taps ?? tapConfig?.taps ?? [];
    for (const t of src) {
      edits[t.tap_number] = { recipe_id: t.recipe_id ?? "", label: t.label ?? "" };
    }
    setTapEdits(edits);
    setEditingTaps(true);
  }

  function getTapEdit(n: number) {
    return tapEdits[n] ?? { recipe_id: "", label: "" };
  }
  function setTapEdit(n: number, field: "recipe_id" | "label", val: string) {
    setTapEdits((e) => ({ ...e, [n]: { ...getTapEdit(n), [field]: val } }));
  }

  async function saveTaps() {
    setSaving(true);
    const count = parseInt(tapCountInput) || 8;
    const taps = Array.from({ length: count }, (_, i) => {
      const e = tapEdits[i + 1] ?? { recipe_id: "", label: "" };
      return { tap_number: i + 1, recipe_id: e.recipe_id || null, label: e.label || null };
    });
    try {
      const res = await fetch("/api/taproom/tap-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tap_count: count, taps }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      setEditingTaps(false);
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.taproom.draftStats() }),
        qc.invalidateQueries({ queryKey: queryKeys.taproom.tapConfig() }),
      ]);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Error");
    } finally {
      setSaving(false);
    }
  }

  async function toggleRetire(recipeId: string, currentlyRetired: boolean) {
    setRetiringSaving(recipeId);
    try {
      const res = await fetch("/api/production/taproom-recipe-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipe_id: recipeId, is_retired: !currentlyRetired }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      await qc.invalidateQueries({ queryKey: queryKeys.taproom.draftStats() });
    } catch (e) {
      alert(e instanceof Error ? e.message : "Error");
    } finally {
      setRetiringSaving(null);
    }
  }

  // ── Shrinkage chart data ────────────────────────────────────────────────────
  // Flatten all keg events into a combined list keyed by date for a unified chart
  const shrinkageItems = stats?.shrinkage_by_recipe ?? [];
  const chartByShrinkageItem = shrinkageItems.map((item, idx) => ({
    ...item,
    color: RECIPE_COLORS[idx % RECIPE_COLORS.length],
  }));

  // One bar per keg-replacement event, colored by recipe
  const chartData: { date: string; recipe: string; shrinkage_fl_oz: number; shrinkage_pct: number }[] =
    chartByShrinkageItem.flatMap((item) =>
      item.events.map((e) => ({
        date: e.date,
        recipe: item.beer_name,
        shrinkage_fl_oz: e.shrinkage_fl_oz,
        shrinkage_pct: e.shrinkage_pct,
      }))
    ).sort((a, b) => a.date.localeCompare(b.date));

  const tapsToRender = editingTaps
    ? Array.from({ length: parseInt(tapCountInput) || 8 }, (_, i) => i + 1)
    : Array.from({ length: stats?.tap_count ?? tapConfig?.tap_count ?? 8 }, (_, i) => i + 1);

  return (
    <div>
      {/* ── Header ── */}
      <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div>
          <p className="text-sm text-zinc-500">
            Draft tap status, sell-through rates, and shrinkage trends from Square inventory.
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => refetch()}
            className="px-3 py-1.5 border border-zinc-700 hover:border-zinc-500 text-zinc-300 text-sm font-medium rounded transition-colors">
            Refresh
          </button>
          <button onClick={() => setShowLinks(true)}
            className="px-3 py-1.5 border border-zinc-700 hover:border-zinc-500 text-zinc-300 text-sm font-medium rounded transition-colors">
            Link to Square
          </button>
          <button onClick={editingTaps ? saveTaps : startEditTaps} disabled={saving}
            className={`px-3 py-1.5 text-sm font-medium rounded transition-colors ${
              editingTaps
                ? "bg-amber-600 hover:bg-amber-500 text-white"
                : "border border-zinc-700 hover:border-zinc-500 text-zinc-300"
            }`}>
            {saving ? "Saving…" : editingTaps ? "Save Taps" : "Configure Taps"}
          </button>
          {editingTaps && (
            <button onClick={() => setEditingTaps(false)}
              className="px-3 py-1.5 border border-zinc-700 text-zinc-500 text-sm rounded transition-colors hover:text-zinc-300">
              Cancel
            </button>
          )}
        </div>
      </div>

      {err && <p className="text-sm text-red-400 mb-3">{err}</p>}

      {/* ── Tap count editor ── */}
      {editingTaps && (
        <div className="mb-4 flex items-center gap-3 p-3 rounded-lg bg-zinc-900 border border-zinc-700">
          <label className="text-xs text-zinc-400 whitespace-nowrap">Number of taps:</label>
          <input
            type="number" min="1" max="32" className="inp w-20 text-center"
            value={tapCountInput}
            onChange={(e) => setTapCountInput(e.target.value)}
          />
          <span className="text-xs text-zinc-600">Tap assignment slots will update below.</span>
        </div>
      )}

      {/* ── Tap grid ── */}
      {isLoading ? (
        <p className="text-zinc-600 text-sm py-10 text-center">Loading tap data from Square…</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 mb-8">
          {tapsToRender.map((tapNum) => {
            const tap = stats?.taps.find((t) => t.tap_number === tapNum);
            const edit = getTapEdit(tapNum);
            const isRetired = tap?.metrics?.is_retired ?? false;
            const daysLeft = tap?.metrics
              ? daysUntilEmpty(tap.metrics.current_bbl, tap.metrics.daily_bbl)
              : null;
            // Urgency tiers based on days remaining.
            // Retired taps keep their urgency color while stock remains so staff
            // know the keg is still running low. Grey out only when truly empty.
            type Urgency = "critical" | "low" | "watch" | "soon" | "good" | "retiring" | "retired" | "none";
            const urgency: Urgency =
              !tap?.recipe_id                          ? "none"
              : daysLeft === null || daysLeft === 0    ? (isRetired ? "retired" : "none")
              : daysLeft <= 3                          ? "critical"
              : daysLeft <= 7                          ? "low"
              : daysLeft <= 14                         ? "watch"
              : daysLeft <= 30                         ? "soon"
              : isRetired                              ? "retiring"
              : "good";

            const cardCls: Record<Urgency, string> = {
              critical: "border-red-500     bg-red-950/25",
              low:      "border-orange-500  bg-orange-950/20",
              watch:    "border-amber-500   bg-amber-950/15",
              soon:     "border-yellow-500/70 bg-yellow-950/10",
              good:     "border-green-700/60 bg-green-950/10",
              retiring: "border-zinc-700 border-dashed",
              retired:  "border-zinc-800 opacity-55",
              none:     "border-zinc-800",
            };

            const badgeCls: Partial<Record<Urgency, { wrap: string; text: string }>> = {
              critical: { wrap: "bg-red-950/60 border-red-500/70",       text: "text-red-400"    },
              low:      { wrap: "bg-orange-950/50 border-orange-500/60", text: "text-orange-400" },
              watch:    { wrap: "bg-amber-950/40 border-amber-500/50",   text: "text-amber-400"  },
              soon:     { wrap: "bg-yellow-950/30 border-yellow-600/50", text: "text-yellow-400" },
            };
            const badgeLabel: Partial<Record<Urgency, string>> = {
              critical: "Critical",
              low:      "Low",
              watch:    "Watch",
              soon:     "Soon",
            };

            const daysLeftCls =
              urgency === "critical" ? "text-red-400"
              : urgency === "low"    ? "text-orange-400"
              : urgency === "watch"  ? "text-amber-400"
              : urgency === "soon"   ? "text-yellow-400"
              : urgency === "good"   ? "text-green-400"
              : "text-zinc-600";

            return (
              <div
                key={tapNum}
                className={`rounded-lg border p-3 flex flex-col gap-2 transition-colors ${cardCls[urgency]}`}
              >
                {/* Tap number + urgency badge */}
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">
                    Tap {tapNum}
                  </span>
                  <div className="flex items-center gap-1.5">
                    {isRetired && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-500 uppercase tracking-wide">
                        Retired
                      </span>
                    )}
                    {badgeLabel[urgency] && (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${badgeCls[urgency]!.wrap} ${badgeCls[urgency]!.text}`}>
                        {badgeLabel[urgency]}
                      </span>
                    )}
                  </div>
                </div>

                {/* Recipe assignment */}
                {editingTaps ? (
                  <div className="space-y-1.5">
                    <select
                      className="inp text-xs w-full"
                      value={edit.recipe_id}
                      onChange={(e) => setTapEdit(tapNum, "recipe_id", e.target.value)}
                    >
                      <option value="">— empty tap —</option>
                      {draftRecipes.map((r) => (
                        <option key={r.id} value={r.id}>{r.beer_name}</option>
                      ))}
                    </select>
                    <input
                      className="inp text-xs w-full"
                      placeholder="Label (optional)"
                      value={edit.label}
                      onChange={(e) => setTapEdit(tapNum, "label", e.target.value)}
                    />
                  </div>
                ) : (
                  <div>
                    {tap?.beer_name ? (
                      <p className="text-sm font-medium text-zinc-100">{tap.beer_name}</p>
                    ) : (
                      <p className="text-sm text-zinc-600 italic">Empty</p>
                    )}
                    {tap?.label && <p className="text-xs text-zinc-500">{tap.label}</p>}
                  </div>
                )}

                {/* Metrics */}
                {!editingTaps && tap?.metrics && (
                  <>
                    <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-xs">
                      <div>
                        <span className="text-zinc-600">fl oz avail</span>
                        <p className="text-zinc-200 tabular-nums font-medium">
                          {tap.metrics.current_fl_oz.toLocaleString()} oz
                        </p>
                      </div>
                      <div>
                        <span className="text-zinc-600">BBL on hand</span>
                        <p className="text-zinc-200 tabular-nums font-medium">
                          {tap.metrics.current_bbl.toFixed(2)}
                        </p>
                      </div>
                      <div>
                        <span className="text-zinc-600">oz / day</span>
                        <p className="text-zinc-300 tabular-nums">
                          {tap.metrics.daily_fl_oz > 0 ? tap.metrics.daily_fl_oz.toFixed(0) : "—"}
                        </p>
                      </div>
                      <div>
                        <span className="text-zinc-600">days left</span>
                        <p className={`tabular-nums font-semibold ${daysLeftCls}`}>
                          {daysLeft !== null ? `~${daysLeft}d` : "—"}
                        </p>
                      </div>
                    </div>
                    {tap.recipe_id && (
                      <button
                        onClick={() => toggleRetire(tap.recipe_id!, isRetired)}
                        disabled={retiringSaving === tap.recipe_id}
                        className={`text-[10px] self-start px-2 py-0.5 rounded border transition-colors ${
                          isRetired
                            ? "border-zinc-700 text-zinc-500 hover:text-zinc-300 hover:border-zinc-500"
                            : "border-zinc-700 text-zinc-600 hover:text-amber-400 hover:border-amber-700"
                        }`}
                      >
                        {retiringSaving === tap.recipe_id ? "…" : isRetired ? "Unretire" : "Mark Retired"}
                      </button>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Shrinkage section ── */}
      {shrinkageItems.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-sm font-semibold text-zinc-200">Draft Shrinkage</h3>
              <p className="text-xs text-zinc-500 mt-0.5">
                fl oz remaining when a keg was replaced — lower is better · last {shrinkageDays} days
              </p>
            </div>
          </div>

          {/* Summary cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
            {chartByShrinkageItem.map((item) => (
              <div key={item.recipe_id}
                className="rounded-lg border border-zinc-800 p-3 flex items-center gap-3">
                <div className="w-3 h-3 rounded-full shrink-0" style={{ background: item.color }} />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-zinc-200 truncate">{item.beer_name}</p>
                  <p className="text-xs text-zinc-500">
                    Avg <span className="text-zinc-300 tabular-nums">{item.avg_shrinkage_fl_oz} oz</span>
                    {" "}({item.avg_shrinkage_pct}%)
                    {" "}· {item.keg_count} keg{item.keg_count !== 1 ? "s" : ""}
                  </p>
                </div>
              </div>
            ))}
          </div>

          {/* Chart */}
          {chartData.length > 0 ? (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-4">
              <h4 className="text-xs font-medium text-zinc-500 uppercase tracking-wide mb-3">
                Shrinkage per Keg Replacement (fl oz remaining)
              </h4>
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={chartData} margin={{ top: 5, right: 16, left: 0, bottom: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#3f3f46" />
                  <XAxis
                    dataKey="date"
                    tick={{ fill: "#a1a1aa", fontSize: 11 }}
                    tickLine={{ stroke: "#52525b" }}
                    axisLine={{ stroke: "#52525b" }}
                    angle={-30} textAnchor="end" height={45}
                  />
                  <YAxis
                    tick={{ fill: "#a1a1aa", fontSize: 11 }}
                    tickLine={{ stroke: "#52525b" }}
                    axisLine={{ stroke: "#52525b" }}
                    label={{ value: "fl oz", angle: -90, position: "insideLeft", fill: "#71717a", fontSize: 11, dy: 30 }}
                  />
                  <Tooltip
                    contentStyle={{ backgroundColor: "#18181b", border: "1px solid #3f3f46", borderRadius: "6px", fontSize: 12, color: "#e4e4e7" }}
                    labelStyle={{ color: "#e4e4e7", fontWeight: 600 }}
                    itemStyle={{ color: "#a1a1aa" }}
                    formatter={(val, _name, props) => [
                      `${val} fl oz (${props.payload?.shrinkage_pct ?? 0}%)`,
                      props.payload?.recipe ?? "",
                    ]}
                  />
                  <Bar dataKey="shrinkage_fl_oz" radius={[2, 2, 0, 0]}>
                    {chartData.map((entry, idx) => {
                      const color = chartByShrinkageItem.find((i) => i.beer_name === entry.recipe)?.color ?? "#a1a1aa";
                      return <Cell key={idx} fill={color} fillOpacity={0.8} />;
                    })}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>

              {/* Legend */}
              <div className="flex flex-wrap gap-3 mt-2">
                {chartByShrinkageItem.map((item) => (
                  <span key={item.recipe_id} className="flex items-center gap-1.5 text-xs text-zinc-400">
                    <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: item.color }} />
                    {item.beer_name}
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-sm text-zinc-600 py-4">
              No keg replacement events detected in the last {shrinkageDays} days. Shrinkage is recorded when Square shows a physical count going from low back to ~660 fl oz.
            </p>
          )}
        </div>
      )}

      {shrinkageItems.length === 0 && !isLoading && (
        <div className="py-8 text-center">
          <p className="text-zinc-600 text-sm">
            {draftRecipeIds.size === 0
              ? "No draft items linked to Square yet. Use \"Link to Square\" to map recipes."
              : "No shrinkage data found for the selected period."}
          </p>
        </div>
      )}

      {/* ── Link to Square modal ── */}
      {showLinks && (
        <SquareLinkManager
          recipes={
            // Pass all recipes that have any link so the manager shows them.
            // The full recipes list isn't available here; use what we have from links.
            links
              .filter((l) => l.recipes?.beer_name)
              .reduce<Recipe[]>((acc, l) => {
                if (!acc.find((r) => r.id === l.recipe_id)) {
                  acc.push({ id: l.recipe_id, beer_name: l.recipes!.beer_name! } as Recipe);
                }
                return acc;
              }, [])
          }
          links={links}
          onClose={() => setShowLinks(false)}
          onChanged={() => {
            qc.invalidateQueries({ queryKey: queryKeys.production.recipeSquareLinks() });
            qc.invalidateQueries({ queryKey: queryKeys.taproom.draftStats() });
          }}
        />
      )}
    </div>
  );
}

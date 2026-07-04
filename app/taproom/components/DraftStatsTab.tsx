"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import dynamic from "next/dynamic";
import ChartSkeleton from "@/app/components/ChartSkeleton";
import { fetchJson } from "../../production/hooks/queries";
import type { RecipeSquareLinkRow } from "../../production/types";

const DraftStatsChart = dynamic(() => import("./DraftStatsChart"), {
  ssr: false,
  loading: () => <ChartSkeleton height={260} />,
});

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
    queryFn:  () => fetchJson<RecipeSquareLinkRow[]>("/api/production/recipe-square-links"),
    staleTime: 5 * 60_000,
  });

  // Recipes with at least one draft link
  const draftRecipeIds = new Set(links.filter((l) => l.packaging === "draft").map((l) => l.recipe_id));

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
          <p className="text-sm text-muted">
            Draft tap status, sell-through rates, and shrinkage trends from Square inventory.
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => refetch()}
            className="px-3 py-1.5 border border-line-strong hover:border-line-subtle text-body text-sm font-medium rounded transition-colors">
            Refresh
          </button>
          <button onClick={editingTaps ? saveTaps : startEditTaps} disabled={saving}
            className={`px-3 py-1.5 text-sm font-medium rounded transition-colors ${
              editingTaps
                ? "bg-accent-emphasis hover:bg-accent text-canvas"
                : "border border-line-strong hover:border-line-subtle text-body"
            }`}>
            {saving ? "Saving…" : editingTaps ? "Save Taps" : "Configure Taps"}
          </button>
          {editingTaps && (
            <button onClick={() => setEditingTaps(false)}
              className="px-3 py-1.5 border border-line-strong text-muted text-sm rounded transition-colors hover:text-body">
              Cancel
            </button>
          )}
        </div>
      </div>

      {err && <p className="text-sm text-danger mb-3">{err}</p>}

      {/* ── Tap count editor ── */}
      {editingTaps && (
        <div className="mb-4 flex items-center gap-3 p-3 rounded-lg bg-surface border border-line-strong">
          <label className="text-xs text-secondary whitespace-nowrap">Number of taps:</label>
          <input
            type="number" min="1" max="32" className="inp w-20 text-center"
            value={tapCountInput}
            onChange={(e) => setTapCountInput(e.target.value)}
          />
          <span className="text-xs text-faint">Tap assignment slots will update below.</span>
        </div>
      )}

      {/* ── Tap grid ── */}
      {isLoading ? (
        <p className="text-faint text-sm py-10 text-center">Loading tap data from Square…</p>
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

            // Urgency ramp (critical→good) is a deliberate data-category palette,
            // exempt from token migration per UI_STANDARD; only the neutral
            // retiring/retired/none states use surface tokens.
            const cardCls: Record<Urgency, string> = {
              critical: "border-red-500     bg-red-950/25",
              low:      "border-orange-500  bg-orange-950/20",
              watch:    "border-amber-500   bg-amber-950/15",
              soon:     "border-yellow-500/70 bg-yellow-950/10",
              good:     "border-green-700/60 bg-green-950/10",
              retiring: "border-line-strong border-dashed",
              retired:  "border-line opacity-55",
              none:     "border-line",
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
              : "text-faint";

            return (
              <div
                key={tapNum}
                className={`rounded-lg border p-3 flex flex-col gap-2 transition-colors ${cardCls[urgency]}`}
              >
                {/* Tap number + urgency badge */}
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-muted uppercase tracking-wider">
                    Tap {tapNum}
                  </span>
                  <div className="flex items-center gap-1.5">
                    {isRetired && (
                      <span className="text-xs px-1.5 py-0.5 rounded border border-line-strong text-muted uppercase tracking-wide">
                        Retired
                      </span>
                    )}
                    {badgeLabel[urgency] && (
                      <span className={`text-xs px-1.5 py-0.5 rounded border font-medium ${badgeCls[urgency]!.wrap} ${badgeCls[urgency]!.text}`}>
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
                      <p className="text-sm font-medium text-primary">{tap.beer_name}</p>
                    ) : (
                      <p className="text-sm text-faint italic">Empty</p>
                    )}
                    {tap?.label && <p className="text-xs text-muted">{tap.label}</p>}
                  </div>
                )}

                {/* Metrics */}
                {!editingTaps && tap?.metrics && (
                  <>
                    <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-xs">
                      <div>
                        <span className="text-faint">fl oz avail</span>
                        <p className="text-strong tabular-nums font-medium">
                          {tap.metrics.current_fl_oz.toLocaleString()} oz
                        </p>
                      </div>
                      <div>
                        <span className="text-faint">BBL on hand</span>
                        <p className="text-strong tabular-nums font-medium">
                          {tap.metrics.current_bbl.toFixed(2)}
                        </p>
                      </div>
                      <div>
                        <span className="text-faint">oz / day</span>
                        <p className="text-body tabular-nums">
                          {tap.metrics.daily_fl_oz > 0 ? Math.round(tap.metrics.daily_fl_oz).toLocaleString() : "—"}
                        </p>
                      </div>
                      <div>
                        <span className="text-faint">days left</span>
                        <p className={`tabular-nums font-semibold ${daysLeftCls}`}>
                          {daysLeft !== null ? `~${daysLeft}d` : "—"}
                        </p>
                      </div>
                    </div>
                    {tap.recipe_id && (
                      <button
                        onClick={() => toggleRetire(tap.recipe_id!, isRetired)}
                        disabled={retiringSaving === tap.recipe_id}
                        className={`text-xs self-start px-2 py-0.5 rounded border transition-colors ${
                          isRetired
                            ? "border-line-strong text-muted hover:text-body hover:border-line-subtle"
                            : "border-line-strong text-faint hover:text-accent hover:border-accent-border"
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
              <h3 className="text-sm font-semibold text-strong">Draft Shrinkage</h3>
              <p className="text-xs text-muted mt-0.5">
                fl oz remaining when a keg was replaced — lower is better · last {shrinkageDays} days
              </p>
            </div>
          </div>

          {/* Summary cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
            {chartByShrinkageItem.map((item) => (
              <div key={item.recipe_id}
                className="rounded-lg border border-line p-3 flex items-center gap-3">
                <div className="w-3 h-3 rounded-full shrink-0" style={{ background: item.color }} />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-strong truncate">{item.beer_name}</p>
                  <p className="text-xs text-muted">
                    Avg <span className="text-body tabular-nums">{item.avg_shrinkage_fl_oz} oz</span>
                    {" "}({item.avg_shrinkage_pct}%)
                    {" "}· {item.keg_count} keg{item.keg_count !== 1 ? "s" : ""}
                  </p>
                </div>
              </div>
            ))}
          </div>

          {/* Chart */}
          {chartData.length > 0 ? (
            <div className="rounded-lg border border-line bg-surface/30 p-4">
              <h4 className="text-xs font-medium text-muted uppercase tracking-wide mb-3">
                Shrinkage per Keg Replacement (fl oz remaining)
              </h4>
              <DraftStatsChart chartData={chartData} chartByShrinkageItem={chartByShrinkageItem} />

              {/* Legend */}
              <div className="flex flex-wrap gap-3 mt-2">
                {chartByShrinkageItem.map((item) => (
                  <span key={item.recipe_id} className="flex items-center gap-1.5 text-xs text-secondary">
                    <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: item.color }} />
                    {item.beer_name}
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-sm text-faint py-4">
              No keg replacement events detected in the last {shrinkageDays} days. Shrinkage is recorded when Square shows a physical count going from low back to ~660 fl oz.
            </p>
          )}
        </div>
      )}

      {shrinkageItems.length === 0 && !isLoading && (
        <div className="py-8 text-center">
          <p className="text-faint text-sm">
            {draftRecipeIds.size === 0
              ? "No draft items linked to Square yet. Visit Square Mappings in Settings to link recipes."
              : "No shrinkage data found for the selected period."}
          </p>
        </div>
      )}

      {draftRecipes.length > 0 && <DraftSwapInventorySection draftRecipes={draftRecipes} />}

    </div>
  );
}

// ─── Draft swap inventory ───────────────────────────────────────────────────────
// Per draft recipe, declare which cold-storage keg variation is consumed on a tap
// swap and the full-keg fl oz that marks a fresh keg. Both drive the taproom
// consumption sync (which keg to deplete) and swap detection (the retop level).

interface SwapSettingRow {
  recipe_id: string;
  swap_variation_id: string | null;
  swap_volume_fl_oz: number | null;
}

interface RPVRow {
  recipe_id: string;
  variation_id: string;
  packaging_variations:
    | {
        id: string;
        name: string;
        is_active: boolean;
        container?: { type?: string | null; volume_fl_oz?: number | null } | null;
      }
    | null;
}

interface KegOption {
  variation_id: string;
  name: string;
  container_volume_fl_oz: number | null;
}

function DraftSwapInventorySection({ draftRecipes }: { draftRecipes: RecipeOption[] }) {
  const qc = useQueryClient();

  const { data: settings = [] } = useQuery({
    queryKey: queryKeys.production.taproomRecipeSettings(),
    queryFn:  () => fetchJson<SwapSettingRow[]>("/api/production/taproom-recipe-settings"),
    staleTime: 60_000,
  });
  const { data: rpv = [] } = useQuery({
    queryKey: queryKeys.production.recipePackagingVariations(),
    queryFn:  () => fetchJson<RPVRow[]>("/api/production/recipe-packaging-variations"),
    staleTime: 5 * 60_000,
  });

  // Keg-container variations available per recipe, for the dropdown.
  const kegOptionsByRecipe = new Map<string, KegOption[]>();
  for (const row of rpv) {
    const pv = row.packaging_variations;
    if (!pv || !pv.is_active || pv.container?.type !== "keg") continue;
    const list = kegOptionsByRecipe.get(row.recipe_id) ?? [];
    list.push({ variation_id: pv.id, name: pv.name, container_volume_fl_oz: pv.container?.volume_fl_oz ?? null });
    kegOptionsByRecipe.set(row.recipe_id, list);
  }

  const settingByRecipe = new Map(settings.map((s) => [s.recipe_id, s]));

  const [edits, setEdits]   = useState<Record<string, { variationId: string; volume: string }>>({});
  const [savingId, setSaving] = useState<string | null>(null);
  const [error, setError]   = useState<string | null>(null);

  function currentFor(recipeId: string): { variationId: string; volume: string } {
    if (edits[recipeId]) return edits[recipeId];
    const s = settingByRecipe.get(recipeId);
    return {
      variationId: s?.swap_variation_id ?? "",
      volume:      s?.swap_volume_fl_oz != null ? String(s.swap_volume_fl_oz) : "",
    };
  }

  function onSelectVariation(recipeId: string, variationId: string) {
    const opt = (kegOptionsByRecipe.get(recipeId) ?? []).find((o) => o.variation_id === variationId);
    const cur = currentFor(recipeId);
    // Auto-fill the full-keg volume from the chosen container, but only when the
    // field is empty so a manual override is never clobbered.
    const volume = cur.volume === "" && opt?.container_volume_fl_oz != null
      ? String(opt.container_volume_fl_oz)
      : cur.volume;
    setEdits((e) => ({ ...e, [recipeId]: { variationId, volume } }));
  }

  function onVolume(recipeId: string, volume: string) {
    setEdits((e) => ({ ...e, [recipeId]: { ...currentFor(recipeId), volume } }));
  }

  async function save(recipeId: string) {
    const cur = currentFor(recipeId);
    setSaving(recipeId);
    setError(null);
    try {
      const res = await fetch("/api/production/taproom-recipe-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipe_id:          recipeId,
          swap_variation_id:  cur.variationId || null,
          swap_volume_fl_oz:  cur.volume ? Number(cur.volume) : null,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      setEdits((e) => { const n = { ...e }; delete n[recipeId]; return n; });
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.production.taproomRecipeSettings() }),
        qc.invalidateQueries({ queryKey: queryKeys.taproom.draftStats() }),
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="mt-8">
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-strong">Draft Swap Inventory</h3>
        <p className="text-xs text-muted mt-0.5">
          Which cold-storage keg is consumed when a tap is swapped, and the full-keg fl oz.
          Drives taproom consumption tracking and shrinkage detection.
        </p>
      </div>

      {error && <p className="text-xs text-danger mb-2">{error}</p>}

      <div className="rounded-lg border border-line divide-y divide-line">
        {draftRecipes.map((r) => {
          const opts       = kegOptionsByRecipe.get(r.id) ?? [];
          const cur        = currentFor(r.id);
          const setting    = settingByRecipe.get(r.id);
          const configured = Boolean(setting?.swap_variation_id && setting?.swap_volume_fl_oz);
          const dirty      = Boolean(edits[r.id]);

          return (
            <div key={r.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <span className="text-sm text-strong truncate">{r.beer_name}</span>
                {!configured && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded border border-line-strong text-muted uppercase tracking-wide shrink-0">
                    Not configured
                  </span>
                )}
              </div>

              <select
                className="inp text-xs w-44"
                value={cur.variationId}
                onChange={(e) => onSelectVariation(r.id, e.target.value)}
              >
                <option value="">— swap keg —</option>
                {opts.map((o) => (
                  <option key={o.variation_id} value={o.variation_id}>{o.name}</option>
                ))}
              </select>

              <div className="flex items-center gap-1">
                <input
                  type="number" min="0" step="1"
                  className="inp text-xs w-24"
                  placeholder="fl oz"
                  value={cur.volume}
                  onChange={(e) => onVolume(r.id, e.target.value)}
                />
                <span className="text-xs text-faint">fl oz</span>
              </div>

              <button
                onClick={() => save(r.id)}
                disabled={savingId === r.id || !dirty}
                className="btn-amber btn-xs disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {savingId === r.id ? "Saving…" : "Save"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import dynamic from "next/dynamic";
import ChartSkeleton from "@/app/components/ChartSkeleton";
import { fetchJson } from "../../production/hooks/queries";
import type { RecipeSquareLinkRow, AvailableInventoryLine, RecipePackagingVariation, PackagingVariation } from "../../production/types";
import {
  type DraftUrgency,
  DRAFT_URGENCY_CARD,
  DRAFT_URGENCY_BADGE,
  DRAFT_URGENCY_LABEL,
  DRAFT_URGENCY_DAYS_TEXT,
} from "./categoryStyles";

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
  draft_restock_item_id: string | null;
  taps: {
    tap_number: number;
    recipe_id: string | null;
    label: string | null;
    restock_variation_id?: string | null;
    swap_variation_id?: string | null;
    swap_volume_fl_oz?: number | null;
    recipes?: { beer_name: string } | null;
  }[];
}

interface SquareCatalogVariation {
  variation_id: string;
  item_id: string;
  item_name: string;
  variation_name: string;
}

interface RecipeOption {
  id: string;
  beer_name: string;
}

/** A recipe's configured keg variation, with an optional on-hand hint —
 *  present for every active keg variation regardless of cold-storage stock. */
interface SwapKegOption {
  variation_id: string;
  variation_name: string;
  total_volume_fl_oz: number | null;
  quantity_on_hand: number | null;
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

  // Square catalog variations (for the per-tap "Draft Restock" line mapping).
  const { data: catalogVariations = [] } = useQuery({
    queryKey: queryKeys.production.squareCatalog(),
    queryFn:  () => fetchJson<SquareCatalogVariation[]>("/api/production/square-catalog"),
    staleTime: 5 * 60_000,
  });

  // Cold-storage on-hand kegs, used solely for the "(N on hand)" hint below —
  // the swap dropdown itself lists every configured keg variation regardless
  // of stock (a phantom export is booked when cold storage is short).
  const { data: coldStorage = [] } = useQuery({
    queryKey: queryKeys.production.exportBayInventory(),
    queryFn:  () => fetchJson<AvailableInventoryLine[]>("/api/production/export-bay/inventory"),
    staleTime: 60_000,
  });

  // Every recipe's active keg variations, regardless of stock — the source of
  // truth for the "keg to drain" dropdown (fetched once, unfiltered, and
  // grouped client-side since many taps/recipes render at once).
  const { data: recipePackagingVariations = [] } = useQuery({
    queryKey: queryKeys.production.recipePackagingVariations(),
    queryFn:  () => fetchJson<RecipePackagingVariation[]>("/api/production/recipe-packaging-variations"),
    staleTime: 5 * 60_000,
  });

  // All packaging variations — used only to surface the generic house kegs
  // (no contract partner), which have no recipe link but are the keg every
  // in-house draft beer actually drains.
  const { data: packagingVariations = [] } = useQuery({
    queryKey: queryKeys.production.packagingVariations(),
    queryFn:  () => fetchJson<PackagingVariation[]>("/api/production/packaging-variations"),
    staleTime: 5 * 60_000,
  });

  const onHandByVariation = new Map<string, number>();
  for (const line of coldStorage) {
    if (line.container_type !== "keg" || line.quantity_on_hand <= 0) continue;
    onHandByVariation.set(line.variation_id, line.quantity_on_hand);
  }

  // Per-recipe keg variations configured (container = keg), with an on-hand
  // hint cross-referenced from cold storage — present whether or not there's
  // any stock.
  const kegOptionsByRecipe = new Map<string, SwapKegOption[]>();
  for (const link of recipePackagingVariations) {
    const variation = link.packaging_variations;
    if (!variation || variation.container?.type !== "keg") continue;
    const list = kegOptionsByRecipe.get(link.recipe_id) ?? [];
    list.push({
      variation_id: link.variation_id,
      variation_name: variation.name,
      total_volume_fl_oz: variation.total_volume_fl_oz,
      quantity_on_hand: onHandByVariation.get(link.variation_id) ?? null,
    });
    kegOptionsByRecipe.set(link.recipe_id, list);
  }

  // Generic house kegs (active, keg container, no contract partner). These have
  // no recipe_packaging_variations link, so they never appear in the per-recipe
  // map above — yet they're the keg every in-house draft beer drains. Offer them
  // on every tap alongside the recipe's own (partner) linked kegs.
  const genericKegOptions: SwapKegOption[] = [];
  for (const v of packagingVariations) {
    if (!v.is_active || v.partner_id !== null || v.container?.type !== "keg") continue;
    genericKegOptions.push({
      variation_id: v.id,
      variation_name: v.name,
      total_volume_fl_oz: v.total_volume_fl_oz,
      quantity_on_hand: onHandByVariation.get(v.id) ?? null,
    });
  }

  // Swap-keg options for a tap: its recipe's linked kegs first, then the generic
  // house kegs, deduped by variation.
  function kegsForRecipe(recipeId: string): SwapKegOption[] {
    if (!recipeId) return [];
    const linked = kegOptionsByRecipe.get(recipeId) ?? [];
    const seen = new Set(linked.map((k) => k.variation_id));
    return [...linked, ...genericKegOptions.filter((k) => !seen.has(k.variation_id))];
  }

  // Full-keg volume is the packaging variation's coded fl oz — never hand-entered.
  const codedVolumeFor = (line: SwapKegOption): number | null => line.total_volume_fl_oz;
  const isSixthKeg = (line: SwapKegOption): boolean => /\b1\/6\b/.test(line.variation_name);

  // Recipes with at least one draft link
  const draftRecipeIds = new Set(links.filter((l) => l.packaging === "draft").map((l) => l.recipe_id));

  const [editingTaps, setEditingTaps] = useState(false);
  const [tapCountInput, setTapCountInput] = useState("");
  const [tapEdits, setTapEdits] = useState<Record<number, {
    recipe_id: string; label: string; restock_variation_id: string;
    swap_variation_id: string; swap_volume_fl_oz: string;
  }>>({});
  const [restockItemId, setRestockItemId] = useState("");
  const [saving, setSaving] = useState(false);
  const [retiringSaving, setRetiringSaving] = useState<string | null>(null);

  // Variations belonging to the chosen "Draft Restock" Square item, for the
  // per-tap dropdowns. Empty until an item is selected.
  const restockVariations = catalogVariations.filter((v) => v.item_id === restockItemId);
  // Distinct Square items, for the restock-item picker.
  const catalogItems = Array.from(
    new Map(catalogVariations.map((v) => [v.item_id, v.item_name])).entries(),
  )
    .map(([item_id, item_name]) => ({ item_id, item_name }))
    .sort((a, b) => a.item_name.localeCompare(b.item_name));

  // Tap numbers that already have a restock line mapped (for the at-a-glance badge).
  const restockMappedTaps = new Set(
    (tapConfig?.taps ?? []).filter((t) => t.restock_variation_id).map((t) => t.tap_number),
  );

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
    // Pull the latest Square catalog so a just-synced restock item is selectable
    // without a manual page reload.
    qc.invalidateQueries({ queryKey: queryKeys.production.squareCatalog() });
    setTapCountInput(String(stats?.tap_count ?? tapConfig?.tap_count ?? 8));
    setRestockItemId(tapConfig?.draft_restock_item_id ?? "");
    const edits: Record<number, {
      recipe_id: string; label: string; restock_variation_id: string;
      swap_variation_id: string; swap_volume_fl_oz: string;
    }> = {};
    // Recipe/label come from the richest source; restock + swap config live only
    // on the tap-config payload, so key those in by tap number from there.
    const restockByTap = new Map((tapConfig?.taps ?? []).map((t) => [t.tap_number, t.restock_variation_id ?? ""]));
    const swapVarByTap = new Map((tapConfig?.taps ?? []).map((t) => [t.tap_number, t.swap_variation_id ?? ""]));
    const swapVolByTap = new Map((tapConfig?.taps ?? []).map((t) => [t.tap_number, t.swap_volume_fl_oz != null ? String(t.swap_volume_fl_oz) : ""]));
    const src = stats?.taps ?? tapConfig?.taps ?? [];
    for (const t of src) {
      edits[t.tap_number] = {
        recipe_id: t.recipe_id ?? "",
        label: t.label ?? "",
        restock_variation_id: restockByTap.get(t.tap_number) ?? "",
        swap_variation_id: swapVarByTap.get(t.tap_number) ?? "",
        swap_volume_fl_oz: swapVolByTap.get(t.tap_number) ?? "",
      };
    }
    setTapEdits(edits);
    setEditingTaps(true);
  }

  function getTapEdit(n: number) {
    return tapEdits[n] ?? { recipe_id: "", label: "", restock_variation_id: "", swap_variation_id: "", swap_volume_fl_oz: "" };
  }
  function setTapEdit(n: number, field: "recipe_id" | "label" | "restock_variation_id" | "swap_variation_id" | "swap_volume_fl_oz", val: string) {
    setTapEdits((e) => ({ ...e, [n]: { ...getTapEdit(n), [field]: val } }));
  }

  // Auto-map each tap to the restock variation whose name contains its tap
  // number (e.g. "Tap 3"), for the chosen restock item. Never clobbers a slot
  // that already has a mapping.
  function autoMatchRestock() {
    const count = parseInt(tapCountInput) || 8;
    setTapEdits((e) => {
      const next = { ...e };
      for (let n = 1; n <= count; n++) {
        const cur = next[n] ?? getTapEdit(n);
        if (cur.restock_variation_id) continue;
        const match = restockVariations.find((v) => new RegExp(`\\b0*${n}\\b`).test(v.variation_name));
        if (match) next[n] = { ...cur, restock_variation_id: match.variation_id };
      }
      return next;
    });
  }

  // Fill each tap's swap keg from its recipe's on-hand cold-storage kegs: the
  // sole SKU when there's one, else the largest-volume. Never clobbers a manual
  // pick, and auto-fills the recount volume when empty.
  function autoMapKegs() {
    setTapEdits((prev) => {
      const next = { ...prev };
      for (let n = 1; n <= (tapsToRender.length || 0); n++) {
        const cur = next[n] ?? { recipe_id: "", label: "", restock_variation_id: "", swap_variation_id: "", swap_volume_fl_oz: "" };
        if (!cur.recipe_id || cur.swap_variation_id) continue;
        const kegs = kegsForRecipe(cur.recipe_id);
        if (kegs.length === 0) continue;
        // Bias toward 1/6 kegs whenever one is on hand; else sole SKU, else largest.
        const sixths = kegs.filter(isSixthKeg);
        const pool = sixths.length ? sixths : kegs;
        const pick = pool.length === 1
          ? pool[0]
          : [...pool].sort((a, b) => (codedVolumeFor(b) ?? 0) - (codedVolumeFor(a) ?? 0))[0];
        const vol = codedVolumeFor(pick);
        next[n] = {
          ...cur,
          swap_variation_id: pick.variation_id,
          swap_volume_fl_oz: vol != null ? String(vol) : "",
        };
      }
      return next;
    });
  }

  async function saveTaps() {
    setSaving(true);
    const count = parseInt(tapCountInput) || 8;
    const taps = Array.from({ length: count }, (_, i) => {
      const e = tapEdits[i + 1] ?? { recipe_id: "", label: "", restock_variation_id: "", swap_variation_id: "", swap_volume_fl_oz: "" };
      return {
        tap_number: i + 1,
        recipe_id: e.recipe_id || null,
        label: e.label || null,
        restock_variation_id: e.restock_variation_id || null,
        swap_variation_id: e.swap_variation_id || null,
        swap_volume_fl_oz: e.swap_volume_fl_oz ? Number(e.swap_volume_fl_oz) : null,
      };
    });
    try {
      const res = await fetch("/api/taproom/tap-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tap_count: count, draft_restock_item_id: restockItemId || null, taps }),
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

      {/* ── Draft Restock mapping + Square setup explainer ── */}
      {editingTaps && (
        <div className="mb-6 p-4 rounded-lg bg-surface border border-line-strong space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-strong">Draft Restock line item → tap mapping</h3>
            <p className="text-xs text-muted mt-1 leading-relaxed">
              When a bartender rings the <span className="text-body font-medium">Draft Restock</span> line for a tap,
              the app records a keg-swap shipment (draining the tap&rsquo;s{" "}
              <span className="text-body font-medium">keg to drain</span> set on each tap card below) and recounts that
              tap&rsquo;s draft item back to full in Square. Map each tap to its restock variation here.
            </p>
          </div>

          {/* Square setup explainer */}
          <details className="text-xs rounded-md border border-line bg-canvas/40 px-3 py-2">
            <summary className="cursor-pointer text-secondary font-medium select-none">
              How to set up the Square line item
            </summary>
            <ol className="mt-2 ml-4 list-decimal space-y-1 text-muted leading-relaxed">
              <li>In Square, create one item named <span className="text-body">Draft Restock</span> (or similar), priced <span className="text-body">$0.00</span>.</li>
              <li>Add one <span className="text-body">variation per tap</span>, named so the tap number is clear — e.g. <span className="text-body">&ldquo;Tap 1&rdquo;, &ldquo;Tap 2&rdquo;…</span></li>
              <li>Leave <span className="text-body">inventory tracking off</span> for this item — it&rsquo;s a swap marker, not stock.</li>
              <li>Run <span className="text-body">Sync Catalog</span> (Settings → Square Mappings), then pick the item and map each tap below.</li>
            </ol>
          </details>

          {/* Restock item picker + auto-match */}
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-xs text-secondary whitespace-nowrap">Restock item:</label>
            <select
              className="inp text-xs w-56"
              value={restockItemId}
              onChange={(e) => setRestockItemId(e.target.value)}
            >
              <option value="">— select Square item —</option>
              {catalogItems.map((it) => (
                <option key={it.item_id} value={it.item_id}>{it.item_name}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={autoMatchRestock}
              disabled={!restockItemId || restockVariations.length === 0}
              className="btn-secondary"
            >
              Auto-match by tap #
            </button>
            <button
              type="button"
              onClick={autoMapKegs}
              className="btn-secondary"
            >
              Auto-map kegs
            </button>
            {!restockItemId && (
              <span className="text-xs text-faint">Pick the Square item to enable per-tap mapping.</span>
            )}
          </div>
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
            // Three-tier urgency by days remaining: good → low → critical.
            // A retired tap keeps its normal good/low coloring while it still
            // has beer and only greys out (dashed "retired" style) once it hits
            // critical (empty / ≤3 days) — a retired keg is meant to blow, not
            // be reordered. An unassigned slot stays neutral "none".
            const urgency: DraftUrgency =
              !tap?.recipe_id                      ? "none"
              : daysLeft === null || daysLeft <= 3 ? (isRetired ? "retired" : "critical")
              : daysLeft <= 7                      ? "low"
              : "good";

            // Shared data-category palette (see categoryStyles.ts) — exempt from
            // token migration per UI_STANDARD.
            const cardCls = DRAFT_URGENCY_CARD;
            const badgeCls = DRAFT_URGENCY_BADGE;
            const badgeLabel = DRAFT_URGENCY_LABEL;
            const daysLeftCls = DRAFT_URGENCY_DAYS_TEXT[urgency];

            return (
              <div
                key={tapNum}
                className={`rounded-lg border p-3 flex flex-col gap-2 transition-colors ${cardCls[urgency]}`}
              >
                {/* Tap number + urgency badge */}
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-muted uppercase tracking-wider flex items-center gap-1">
                    Tap {tapNum}
                    {!editingTaps && restockMappedTaps.has(tapNum) && (
                      <span
                        title="Draft Restock line item mapped — keg swaps auto-recount this tap"
                        className="text-accent-soft normal-case tracking-normal"
                      >
                        ⟳
                      </span>
                    )}
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
                  <div className="space-y-2">
                    <div className="space-y-1">
                      <label className="block text-xs text-secondary">Beer on this tap</label>
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
                    </div>
                    <div className="space-y-1">
                      <label className="block text-xs text-secondary">Tap label (optional)</label>
                      <input
                        className="inp text-xs w-full"
                        placeholder="e.g. House lager"
                        value={edit.label}
                        onChange={(e) => setTapEdit(tapNum, "label", e.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="block text-xs text-secondary">Square “Draft Restock” line</label>
                      <select
                        className="inp text-xs w-full disabled:opacity-40"
                        value={edit.restock_variation_id}
                        disabled={!restockItemId}
                        title={restockItemId ? "Square Draft Restock variation for this tap" : "Pick the restock item above first"}
                        onChange={(e) => setTapEdit(tapNum, "restock_variation_id", e.target.value)}
                      >
                        <option value="">— restock variation —</option>
                        {restockVariations.map((v) => (
                          <option key={v.variation_id} value={v.variation_id}>{v.variation_name}</option>
                        ))}
                      </select>
                    </div>
                    {(() => {
                      const kegs = kegsForRecipe(edit.recipe_id);
                      // "Needs a swap keg" means no keg variation is configured for
                      // this recipe at all — not that cold storage is out of stock
                      // (a short swap still books via a phantom export).
                      const needsKeg = !!edit.recipe_id && kegs.length === 0;
                      return (
                        <>
                          <div className="space-y-1">
                            <label className="block text-xs text-secondary">Keg to drain on swap</label>
                            <select
                              className="inp text-xs w-full disabled:opacity-40"
                              value={edit.swap_variation_id}
                              disabled={!edit.recipe_id}
                              title="Keg variation drained when this tap is swapped"
                              onChange={(e) => {
                                const opt = kegs.find((k) => k.variation_id === e.target.value);
                                setTapEdit(tapNum, "swap_variation_id", e.target.value);
                                // Recount target always comes from the keg's coded volume.
                                const vol = opt ? codedVolumeFor(opt) : null;
                                setTapEdit(tapNum, "swap_volume_fl_oz", vol != null ? String(vol) : "");
                              }}
                            >
                              <option value="">— keg to drain —</option>
                              {kegs.map((k) => (
                                <option key={k.variation_id} value={k.variation_id}>
                                  {k.variation_name}
                                  {k.quantity_on_hand != null ? ` (${k.quantity_on_hand} on hand)` : ""}
                                </option>
                              ))}
                            </select>
                            {needsKeg && (
                              <p className="text-xs text-danger">Needs a swap keg</p>
                            )}
                          </div>
                          <div className="space-y-1">
                            <label className="block text-xs text-secondary">Full-keg volume — recount target</label>
                            <p className="text-xs text-body tabular-nums px-1 py-1" title="From the selected keg's packaging variation — not editable">
                              {edit.swap_volume_fl_oz
                                ? `${Number(edit.swap_volume_fl_oz).toLocaleString()} fl oz`
                                : <span className="text-faint">— select a keg —</span>}
                            </p>
                          </div>
                        </>
                      );
                    })()}
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
                        <p
                          className={`tabular-nums font-medium ${tap.metrics.current_fl_oz < 0 ? "text-danger" : "text-strong"}`}
                          title={tap.metrics.current_fl_oz < 0 ? "Negative on-tap level — ring a Draft Restock to swap the keg" : undefined}
                        >
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

    </div>
  );
}

"use client";

import React, { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Recipe } from "../../types";
import { fmtDateLong } from "@/lib/utils/formatting";
import { Modal, Field, ModalActions } from "../shared";
import { usePackagingQuery, fetchJson } from "../../hooks/queries";

interface LinkRow {
  id: string;
  recipe_id: string;
  packaging: "draft" | "keg" | "can";
  packaging_item_id: string | null;
  square_variation_id: string;
  variation_name: string | null;
  item_name: string | null;
  recipes?: { beer_name: string } | null;
  packaging_items?: { id: string; name: string; type: string; volume_fl_oz: number | null } | null;
}

interface VariationBreakdown {
  link_id: string;
  packaging_item_id: string | null;
  packaging_item_name: string | null;
  packaging_item_volume_fl_oz: number | null;
  variation_name: string | null;
  item_name: string | null;
  qty: number;
}

interface InventoryRow {
  recipe_id: string;
  style: string;
  packaging: string;
  current_qty: number;
  history: { week: string; qty: number | null }[];
  daily_sell_through: number;
  lead_time_days: number;
  min_threshold: number;
  forecast_threshold_date: string | null;
  forecast_stockout_date: string | null;
  variations: VariationBreakdown[];
}

interface SquareVariation {
  variation_id: string;
  item_id: string;
  item_name: string;
  variation_name: string;
}

type PackagingType = "draft" | "keg" | "can";

function LinkManager({
  recipes,
  links,
  onClose,
  onChanged,
}: {
  recipes: Recipe[];
  links: LinkRow[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const { data: sqVariations = [], error: sqError } = useQuery({
    queryKey: ["production", "square-catalog"],
    queryFn: () => fetchJson<SquareVariation[]>("/api/production/square-catalog"),
  });
  const { data: packagingItems = [] } = usePackagingQuery();
  const loadErr = sqError instanceof Error ? sqError.message : null;

  const [recipeId, setRecipeId] = useState("");
  const [packagingType, setPackagingType] = useState<PackagingType>("keg");
  const [packagingItemId, setPackagingItemId] = useState("");
  const [variationId, setVariationId] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Sub-items from packaging table filtered to the chosen packaging type.
  const subItems = packagingItems.filter((p) => p.type === packagingType);

  // Reset sub-selections when packaging type changes.
  function pickPackagingType(t: PackagingType) {
    setPackagingType(t);
    setPackagingItemId("");
    setVariationId("");
  }

  async function addLink(e: React.FormEvent) {
    e.preventDefault();
    if (!recipeId || !variationId) return;
    if ((packagingType === "keg" || packagingType === "can") && !packagingItemId) return;
    setSubmitting(true);
    try {
      const sv = sqVariations.find((x) => x.variation_id === variationId);
      const res = await fetch("/api/production/recipe-square-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipe_id: recipeId,
          packaging: packagingType,
          packaging_item_id: packagingItemId || null,
          square_variation_id: variationId,
          square_item_id: sv?.item_id ?? null,
          variation_name: sv?.variation_name ?? null,
          item_name: sv?.item_name ?? null,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      setVariationId("");
      setPackagingItemId("");
      onChanged();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Error");
    } finally {
      setSubmitting(false);
    }
  }

  async function removeLink(id: string) {
    const r = await fetch(`/api/production/recipe-square-links?id=${id}`, { method: "DELETE" });
    if (r.ok) onChanged();
  }

  // Group existing links by recipe then by packaging type for display.
  const byRecipe = new Map<string, { name: string; byType: Map<string, LinkRow[]> }>();
  for (const l of links) {
    const name = l.recipes?.beer_name ?? l.recipe_id;
    if (!byRecipe.has(l.recipe_id)) byRecipe.set(l.recipe_id, { name, byType: new Map() });
    const entry = byRecipe.get(l.recipe_id)!;
    if (!entry.byType.has(l.packaging)) entry.byType.set(l.packaging, []);
    entry.byType.get(l.packaging)!.push(l);
  }

  const needsPackagingItem = packagingType === "keg" || packagingType === "can";
  const selectedPkgItem = subItems.find((p) => p.id === packagingItemId);

  return (
    <Modal title="Link Styles to Square" onClose={onClose} wide>
      <p className="text-xs text-zinc-500 mb-4">
        Each link maps a Recipe × Packaging Type × Specific Packaging to a Square catalog variation.
        For example: Carolina Wheat Wave × Keg × 1/2 Keg → Square variation &quot;Carolina Wheat Wave (Keg) | 1/2 Keg&quot;.
      </p>

      <form onSubmit={addLink} className="space-y-4">
        {/* Row 1: Recipe + Packaging Type */}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Recipe" required>
            <select className="inp" value={recipeId} onChange={(e) => setRecipeId(e.target.value)} required>
              <option value="">— select —</option>
              {recipes.map((r) => <option key={r.id} value={r.id}>{r.beer_name}</option>)}
            </select>
          </Field>
          <Field label="Packaging Type" required>
            <div className="grid grid-cols-3 gap-1.5">
              {(["draft", "keg", "can"] as PackagingType[]).map((t) => (
                <button key={t} type="button" onClick={() => pickPackagingType(t)}
                  className={`py-1.5 rounded border text-xs font-medium transition-colors capitalize ${packagingType === t ? "border-amber-600 bg-amber-900/30 text-amber-300" : "border-zinc-700 bg-zinc-800/50 text-zinc-400 hover:border-zinc-500"}`}>
                  {t}
                </button>
              ))}
            </div>
          </Field>
        </div>

        {/* Row 2: Specific Packaging (keg/can only) + Square Variation */}
        <div className={`grid gap-3 ${needsPackagingItem ? "grid-cols-2" : "grid-cols-1"}`}>
          {needsPackagingItem && (
            <Field label={packagingType === "keg" ? "Keg Size" : "Can Size"} required>
              <select className="inp" value={packagingItemId}
                onChange={(e) => { setPackagingItemId(e.target.value); setVariationId(""); }} required>
                <option value="">— select —</option>
                {subItems.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}{p.volume_fl_oz ? ` (${p.volume_fl_oz} fl oz)` : ""}
                  </option>
                ))}
              </select>
              {subItems.length === 0 && (
                <p className="text-xs text-zinc-600 mt-1">No {packagingType} items. Add them in Inventory → Packaging.</p>
              )}
            </Field>
          )}
          <Field label="Square Variation" required>
            <select className="inp" value={variationId} onChange={(e) => setVariationId(e.target.value)} required
              disabled={needsPackagingItem && !packagingItemId}>
              <option value="">{loadErr ? "(catalog unavailable)" : needsPackagingItem && !packagingItemId ? "← select a size first" : "— select —"}</option>
              {sqVariations.map((v) => (
                <option key={v.variation_id} value={v.variation_id}>
                  {v.item_name}{v.variation_name ? ` | ${v.variation_name}` : ""}
                </option>
              ))}
            </select>
            {loadErr && <p className="text-xs text-red-400 mt-1">{loadErr}</p>}
          </Field>
        </div>

        {/* Preview of the link being created */}
        {recipeId && variationId && (
          <div className="p-3 rounded bg-zinc-800/50 border border-zinc-700/50 text-xs text-zinc-400">
            <span className="text-zinc-300 font-medium">{recipes.find(r => r.id === recipeId)?.beer_name}</span>
            <span className="text-zinc-600"> × </span>
            <span className="capitalize">{packagingType}</span>
            {selectedPkgItem && (
              <>
                <span className="text-zinc-600"> × </span>
                <span>{selectedPkgItem.name}</span>
              </>
            )}
            <span className="text-zinc-600"> → </span>
            <span className="text-amber-400/80">{sqVariations.find(v => v.variation_id === variationId)?.item_name}{sqVariations.find(v => v.variation_id === variationId)?.variation_name ? ` | ${sqVariations.find(v => v.variation_id === variationId)?.variation_name}` : ""}</span>
          </div>
        )}

        <ModalActions submitting={submitting} onCancel={onClose} label="Add Link" />
      </form>

      {/* Existing links */}
      {byRecipe.size > 0 && (
        <div className="mt-6 space-y-5">
          <p className="text-xs font-medium text-zinc-500 uppercase tracking-wide">Existing Links</p>
          {[...byRecipe.entries()].map(([, { name, byType }]) => (
            <div key={name}>
              <p className="text-xs font-semibold text-zinc-200 mb-2">{name}</p>
              <div className="rounded border border-zinc-800 overflow-hidden">
                {[...byType.entries()].map(([type, typeLinks]) => (
                  <div key={type}>
                    <div className="px-3 py-1.5 bg-zinc-800/60 text-xs font-medium text-zinc-500 capitalize border-b border-zinc-800/60">
                      {type}
                    </div>
                    {typeLinks.map((l) => (
                      <div key={l.id} className="flex items-center justify-between px-3 py-2 text-xs border-b border-zinc-800/40 last:border-0">
                        <div className="flex items-center gap-2 min-w-0">
                          {l.packaging_items && (
                            <span className="text-zinc-300 font-medium shrink-0">
                              {l.packaging_items.name}
                              {l.packaging_items.volume_fl_oz && (
                                <span className="text-zinc-600 font-normal"> ({l.packaging_items.volume_fl_oz} fl oz)</span>
                              )}
                            </span>
                          )}
                          {l.packaging_items && <span className="text-zinc-700">→</span>}
                          <span className="text-zinc-500 truncate">
                            {l.item_name ?? "—"}{l.variation_name ? ` | ${l.variation_name}` : ""}
                          </span>
                        </div>
                        <button onClick={() => removeLink(l.id)}
                          className="text-red-400/70 hover:text-red-400 ml-4 shrink-0">
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

function Sparkline({ history }: { history: { week: string; qty: number | null }[] }) {
  const vals = history.map((h) => h.qty).filter((q): q is number => q != null);
  if (vals.length === 0) return <span className="text-zinc-600 text-xs">no data</span>;
  const max = Math.max(...vals, 1);
  return (
    <span className="inline-flex items-end gap-0.5 h-6">
      {history.map((h, i) => (
        <span key={i} title={`${h.week}: ${h.qty ?? "—"}`}
          className="w-1.5 bg-amber-500/70 rounded-sm"
          style={{ height: h.qty != null ? `${Math.max((h.qty / max) * 24, 2)}px` : "2px", opacity: h.qty != null ? 1 : 0.3 }} />
      ))}
    </span>
  );
}

export default function TaproomTab({ recipes }: { recipes: Recipe[] }) {
  const qc = useQueryClient();
  const { data: links = [] } = useQuery({
    queryKey: ["production", "recipe-square-links"],
    queryFn: () => fetchJson<LinkRow[]>("/api/production/recipe-square-links"),
  });
  const { data: rows = [], isLoading: loading, error } = useQuery({
    queryKey: ["production", "taproom-inventory"],
    queryFn: () => fetchJson<InventoryRow[]>("/api/production/taproom-inventory"),
  });
  const loadLinks = () => qc.invalidateQueries({ queryKey: ["production", "recipe-square-links"] });
  const loadInventory = () => qc.invalidateQueries({ queryKey: ["production", "taproom-inventory"] });
  const err = error instanceof Error ? error.message : null;
  const [showLinks, setShowLinks] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggleExpand(key: string) {
    setExpanded((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  }

  const COLS = ["", "Style", "Packaging", "Current", "4-wk Trend", "Sell-through/day", "Lead Time", "Min Threshold", "Threshold Date", "Stockout"];

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <p className="text-sm text-zinc-500">Live taproom inventory from Square, aggregated across all linked variations per style and packaging.</p>
        <button onClick={() => setShowLinks(true)}
          className="px-3 py-1.5 border border-zinc-700 hover:border-zinc-500 text-zinc-300 text-sm font-medium rounded transition-colors">
          Link to Square
        </button>
      </div>

      {err && <p className="text-sm text-red-400 mb-3">{err}</p>}
      {loading ? (
        <p className="text-zinc-600 text-sm py-10 text-center">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-zinc-600 text-sm py-10 text-center">No styles linked to Square yet. Use &quot;Link to Square&quot; to map a recipe.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900/50 text-left">
                {COLS.map((h, i) => <th key={i} className="px-4 py-2.5 text-xs font-medium text-zinc-500 whitespace-nowrap">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => {
                const key = `${row.recipe_id}:${row.packaging}`;
                const near = row.min_threshold > 0 && row.current_qty <= row.min_threshold;
                const isExpanded = expanded.has(key);
                const hasVariations = row.variations.length > 1;
                return (
                  <React.Fragment key={key}>
                    <tr className={`border-b border-zinc-800/60 ${i % 2 !== 0 ? "bg-zinc-900/30" : ""} ${isExpanded ? "border-b-0" : ""}`}>
                      <td className="px-3 py-2.5 w-6">
                        {hasVariations && (
                          <button onClick={() => toggleExpand(key)} className="text-zinc-600 hover:text-zinc-400 text-xs">
                            {isExpanded ? "▼" : "▶"}
                          </button>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-zinc-100 font-medium">{row.style}</td>
                      <td className="px-4 py-2.5 text-zinc-400 capitalize">{row.packaging}</td>
                      <td className={`px-4 py-2.5 tabular-nums ${near ? "text-red-400" : "text-zinc-200"}`}>
                        {row.current_qty}
                        {hasVariations && <span className="text-zinc-600 text-xs ml-1">({row.variations.length} sizes)</span>}
                      </td>
                      <td className="px-4 py-2.5"><Sparkline history={row.history} /></td>
                      <td className="px-4 py-2.5 text-zinc-400 tabular-nums">{row.daily_sell_through}</td>
                      <td className="px-4 py-2.5 text-zinc-400 tabular-nums">{row.lead_time_days}d</td>
                      <td className="px-4 py-2.5 text-zinc-400 tabular-nums">{row.min_threshold}</td>
                      <td className="px-4 py-2.5 text-amber-400/90 text-xs whitespace-nowrap">{row.forecast_threshold_date ? fmtDateLong(row.forecast_threshold_date) : "—"}</td>
                      <td className="px-4 py-2.5 text-zinc-500 text-xs whitespace-nowrap">{row.forecast_stockout_date ? fmtDateLong(row.forecast_stockout_date) : "—"}</td>
                    </tr>
                    {isExpanded && (
                      <tr className={`border-b border-zinc-800/60 ${i % 2 !== 0 ? "bg-zinc-900/30" : ""}`}>
                        <td colSpan={10} className="px-8 pb-3 pt-1">
                          <div className="rounded border border-zinc-800/60 divide-y divide-zinc-800/40">
                            {row.variations.map((v) => (
                              <div key={v.link_id} className="flex items-center gap-6 px-3 py-2 text-xs text-zinc-500">
                                <span className="text-zinc-300 font-medium min-w-[120px]">
                                  {v.packaging_item_name ?? "—"}
                                  {v.packaging_item_volume_fl_oz && (
                                    <span className="text-zinc-600 font-normal"> ({v.packaging_item_volume_fl_oz} fl oz)</span>
                                  )}
                                </span>
                                <span className="text-zinc-600 min-w-[8px]">→</span>
                                <span className="text-zinc-500 truncate">
                                  {v.item_name ?? "—"}{v.variation_name ? ` | ${v.variation_name}` : ""}
                                </span>
                                <span className="tabular-nums text-zinc-300 ml-auto">{v.qty}</span>
                              </div>
                            ))}
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

      {showLinks && (
        <LinkManager
          recipes={recipes}
          links={links}
          onClose={() => setShowLinks(false)}
          onChanged={() => { loadLinks(); loadInventory(); }}
        />
      )}
    </div>
  );
}

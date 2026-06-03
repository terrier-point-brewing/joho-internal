"use client";

import React, { useEffect, useState, useCallback } from "react";
import { Recipe, RecipeSquareLink } from "../../types";
import { fmtDateLong } from "@/lib/utils/formatting";
import { Modal, Field, ModalActions } from "../shared";

interface InventoryRow {
  link_id: string;
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
}

interface SquareVariation {
  variation_id: string;
  item_id: string;
  item_name: string;
  variation_name: string;
}

function LinkManager({
  recipes, links, onClose, onChanged,
}: {
  recipes: Recipe[];
  links: (RecipeSquareLink & { recipes?: { beer_name: string } | null })[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [variations, setVariations] = useState<SquareVariation[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [recipeId, setRecipeId] = useState("");
  const [packaging, setPackaging] = useState("draft");
  const [variationId, setVariationId] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    (async () => {
      const r = await fetch("/api/production/square-catalog");
      if (r.ok) setVariations(await r.json());
      else setLoadErr((await r.json()).error ?? "Failed to load Square catalog");
    })();
  }, []);

  async function addLink(e: React.FormEvent) {
    e.preventDefault();
    if (!recipeId || !variationId) return;
    setSubmitting(true);
    try {
      const v = variations.find((x) => x.variation_id === variationId);
      const res = await fetch("/api/production/recipe-square-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipe_id: recipeId, packaging, square_variation_id: variationId, square_item_id: v?.item_id ?? null }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      setVariationId("");
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

  return (
    <Modal title="Link Styles to Square" onClose={onClose} wide>
      <form onSubmit={addLink} className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <Field label="Recipe" required>
            <select className="inp" value={recipeId} onChange={(e) => setRecipeId(e.target.value)} required>
              <option value="">— select —</option>
              {recipes.map((r) => <option key={r.id} value={r.id}>{r.beer_name}</option>)}
            </select>
          </Field>
          <Field label="Packaging" required>
            <select className="inp" value={packaging} onChange={(e) => setPackaging(e.target.value)}>
              <option value="draft">Draft</option>
              <option value="keg">Keg</option>
              <option value="can">Can</option>
            </select>
          </Field>
          <Field label="Square Item" required>
            <select className="inp" value={variationId} onChange={(e) => setVariationId(e.target.value)} required>
              <option value="">{loadErr ? "(catalog unavailable)" : "— select —"}</option>
              {variations.map((v) => (
                <option key={v.variation_id} value={v.variation_id}>{v.item_name}{v.variation_name ? ` · ${v.variation_name}` : ""}</option>
              ))}
            </select>
          </Field>
        </div>
        {loadErr && <p className="text-xs text-red-400">{loadErr}</p>}
        <ModalActions submitting={submitting} onCancel={onClose} label="Add Link" />
      </form>

      <div className="mt-6">
        <p className="text-xs font-medium text-zinc-500 uppercase tracking-wide mb-2">Existing Links</p>
        {links.length === 0 ? (
          <p className="text-xs text-zinc-600">No links yet.</p>
        ) : (
          <div className="rounded border border-zinc-800 divide-y divide-zinc-800/60">
            {links.map((l) => (
              <div key={l.id} className="flex items-center justify-between px-3 py-2 text-sm">
                <span className="text-zinc-300">{l.recipes?.beer_name ?? "—"} <span className="text-zinc-600 capitalize">· {l.packaging}</span></span>
                <button onClick={() => removeLink(l.id)} className="text-xs text-red-400/80 hover:text-red-400">Remove</button>
              </div>
            ))}
          </div>
        )}
      </div>
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
  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [links, setLinks] = useState<(RecipeSquareLink & { recipes?: { beer_name: string } | null })[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [showLinks, setShowLinks] = useState(false);

  const loadLinks = useCallback(async () => {
    const r = await fetch("/api/production/recipe-square-links");
    if (r.ok) setLinks(await r.json());
  }, []);

  const loadInventory = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch("/api/production/taproom-inventory");
      if (!r.ok) throw new Error((await r.json()).error ?? "Failed to load inventory");
      setRows(await r.json());
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadLinks(); loadInventory(); }, [loadLinks, loadInventory]);

  function onLinksChanged() {
    loadLinks();
    loadInventory();
  }

  const COLS = ["Style", "Packaging", "Current", "4-wk Trend", "Sell-through/day", "Lead Time", "Min Threshold", "Threshold Date", "Stockout"];

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <p className="text-sm text-zinc-500">Live taproom inventory from Square, with forecasted threshold breach by style and packaging.</p>
        <button onClick={() => setShowLinks(true)} className="px-3 py-1.5 border border-zinc-700 hover:border-zinc-500 text-zinc-300 text-sm font-medium rounded transition-colors">Link to Square</button>
      </div>

      {err && <p className="text-sm text-red-400 mb-3">{err}</p>}
      {loading ? (
        <p className="text-zinc-600 text-sm py-10 text-center">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-zinc-600 text-sm py-10 text-center">No styles linked to Square yet. Use “Link to Square” to map a recipe.</p>
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
                const near = row.min_threshold > 0 && row.current_qty <= row.min_threshold;
                return (
                  <tr key={row.link_id} className={`border-b border-zinc-800/60 ${i % 2 !== 0 ? "bg-zinc-900/30" : ""}`}>
                    <td className="px-4 py-2.5 text-zinc-100 font-medium">{row.style}</td>
                    <td className="px-4 py-2.5 text-zinc-400 capitalize">{row.packaging}</td>
                    <td className={`px-4 py-2.5 tabular-nums ${near ? "text-red-400" : "text-zinc-200"}`}>{row.current_qty}</td>
                    <td className="px-4 py-2.5"><Sparkline history={row.history} /></td>
                    <td className="px-4 py-2.5 text-zinc-400 tabular-nums">{row.daily_sell_through}</td>
                    <td className="px-4 py-2.5 text-zinc-400 tabular-nums">{row.lead_time_days}d</td>
                    <td className="px-4 py-2.5 text-zinc-400 tabular-nums">{row.min_threshold}</td>
                    <td className="px-4 py-2.5 text-amber-400/90 text-xs whitespace-nowrap">{row.forecast_threshold_date ? fmtDateLong(row.forecast_threshold_date) : "—"}</td>
                    <td className="px-4 py-2.5 text-zinc-500 text-xs whitespace-nowrap">{row.forecast_stockout_date ? fmtDateLong(row.forecast_stockout_date) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showLinks && <LinkManager recipes={recipes} links={links} onClose={() => setShowLinks(false)} onChanged={onLinksChanged} />}
    </div>
  );
}

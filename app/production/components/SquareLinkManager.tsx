"use client";

import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Recipe } from "../types";
import { Modal } from "./shared";
import { usePackagingQuery, fetchJson } from "../hooks/queries";

export interface LinkRow {
  id: string;
  recipe_id: string;
  packaging: "keg" | "can";
  packaging_item_id: string | null;
  square_variation_id: string;
  variation_name: string | null;
  item_name: string | null;
  recipes?: { beer_name: string } | null;
  packaging_items?: { id: string; name: string; type: string; volume_fl_oz: number | null } | null;
}

interface SquareVariation {
  variation_id: string;
  item_id: string;
  item_name: string;
  variation_name: string;
}

type PackagingType = "keg" | "can";

interface PendingRow {
  uid: number;
  recipe_id: string;
  packaging: PackagingType;
  packaging_item_id: string;
  variation_id: string;
}

let uidSeed = 0;
function newRow(): PendingRow {
  return { uid: uidSeed++, recipe_id: "", packaging: "keg", packaging_item_id: "", variation_id: "" };
}

export function SquareLinkManager({
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

  const [rows, setRows] = useState<PendingRow[]>([newRow()]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateRow(uid: number, patch: Partial<PendingRow>) {
    setRows((rs) => rs.map((r) => {
      if (r.uid !== uid) return r;
      // Reset downstream selections when packaging type changes
      const next = { ...r, ...patch };
      if (patch.packaging && patch.packaging !== r.packaging) {
        next.packaging_item_id = "";
        next.variation_id = "";
      }
      if (patch.packaging_item_id && patch.packaging_item_id !== r.packaging_item_id) {
        next.variation_id = "";
      }
      return next;
    }));
  }

  function removeRow(uid: number) {
    setRows((rs) => rs.length > 1 ? rs.filter((r) => r.uid !== uid) : rs);
  }

  function addRow() {
    setRows((rs) => [...rs, newRow()]);
  }

  const validRows = rows.filter((r) => r.recipe_id && r.packaging_item_id && r.variation_id);

  async function saveAll() {
    if (!validRows.length) return;
    setSubmitting(true);
    setError(null);
    try {
      await Promise.all(validRows.map((r) => {
        const sv = sqVariations.find((v) => v.variation_id === r.variation_id);
        return fetch("/api/production/recipe-square-links", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            recipe_id: r.recipe_id,
            packaging: r.packaging,
            packaging_item_id: r.packaging_item_id,
            square_variation_id: r.variation_id,
            square_item_id: sv?.item_id ?? null,
            variation_name: sv?.variation_name ?? null,
            item_name: sv?.item_name ?? null,
          }),
        }).then(async (res) => {
          if (!res.ok) throw new Error((await res.json()).error ?? "Error");
        });
      }));
      setRows([newRow()]);
      onChanged();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSubmitting(false);
    }
  }

  async function removeLink(id: string) {
    const r = await fetch(`/api/production/recipe-square-links?id=${id}`, { method: "DELETE" });
    if (r.ok) onChanged();
  }

  const byRecipe = new Map<string, { name: string; byType: Map<string, LinkRow[]> }>();
  for (const l of links) {
    const name = l.recipes?.beer_name ?? l.recipe_id;
    if (!byRecipe.has(l.recipe_id)) byRecipe.set(l.recipe_id, { name, byType: new Map() });
    const entry = byRecipe.get(l.recipe_id)!;
    if (!entry.byType.has(l.packaging)) entry.byType.set(l.packaging, []);
    entry.byType.get(l.packaging)!.push(l);
  }

  return (
    <Modal title="Link Styles to Square" onClose={onClose} wide>
      <p className="text-xs text-zinc-500 mb-4">
        Map Recipe × Packaging combinations to Square catalog variations (Keg and Can items).
        Mappings are shared across Taproom intake and Export.
      </p>

      {/* Pending rows */}
      <div className="space-y-2 mb-3">
        {/* Header */}
        <div className="grid gap-2 text-xs text-zinc-500 font-medium px-0.5" style={{ gridTemplateColumns: "1fr 80px 1fr 1fr 24px" }}>
          <span>Recipe</span>
          <span>Type</span>
          <span>Size</span>
          <span>Square Variation</span>
          <span />
        </div>

        {rows.map((row) => {
          const subItems = packagingItems.filter((p) => p.type === row.packaging);
          return (
            <div key={row.uid} className="grid gap-2 items-center" style={{ gridTemplateColumns: "1fr 80px 1fr 1fr 24px" }}>
              {/* Recipe */}
              <select
                className="inp text-sm"
                value={row.recipe_id}
                onChange={(e) => updateRow(row.uid, { recipe_id: e.target.value })}
              >
                <option value="">— recipe —</option>
                {recipes.map((r) => <option key={r.id} value={r.id}>{r.beer_name}</option>)}
              </select>

              {/* Packaging type */}
              <select
                className="inp text-sm"
                value={row.packaging}
                onChange={(e) => updateRow(row.uid, { packaging: e.target.value as PackagingType })}
              >
                <option value="keg">Keg</option>
                <option value="can">Can</option>
              </select>

              {/* Size */}
              <select
                className="inp text-sm"
                value={row.packaging_item_id}
                onChange={(e) => updateRow(row.uid, { packaging_item_id: e.target.value })}
                disabled={!row.recipe_id}
              >
                <option value="">— size —</option>
                {subItems.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}{p.volume_fl_oz ? ` (${p.volume_fl_oz} fl oz)` : ""}
                  </option>
                ))}
              </select>

              {/* Square variation */}
              <select
                className="inp text-sm"
                value={row.variation_id}
                onChange={(e) => updateRow(row.uid, { variation_id: e.target.value })}
                disabled={!row.packaging_item_id}
              >
                <option value="">
                  {loadErr ? "(unavailable)" : !row.packaging_item_id ? "← size first" : "— variation —"}
                </option>
                {sqVariations.map((v) => (
                  <option key={v.variation_id} value={v.variation_id}>
                    {v.item_name}{v.variation_name ? ` | ${v.variation_name}` : ""}
                  </option>
                ))}
              </select>

              {/* Remove row */}
              <button
                type="button"
                onClick={() => removeRow(row.uid)}
                disabled={rows.length === 1}
                className="text-zinc-600 hover:text-red-400 transition-colors text-lg leading-none disabled:opacity-20"
              >
                ×
              </button>
            </div>
          );
        })}
      </div>

      {loadErr && <p className="text-xs text-red-400 mb-2">{loadErr}</p>}
      {error && <p className="text-xs text-red-400 mb-2">{error}</p>}

      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={addRow}
          className="text-xs text-amber-500 hover:text-amber-400 transition-colors"
        >
          + Add row
        </button>
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="btn-ghost text-sm" disabled={submitting}>
            Cancel
          </button>
          <button
            type="button"
            onClick={saveAll}
            disabled={!validRows.length || submitting}
            className="btn-amber disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? "Saving…" : `Save ${validRows.length > 0 ? validRows.length : ""} Link${validRows.length !== 1 ? "s" : ""}`}
          </button>
        </div>
      </div>

      {/* Existing links */}
      {byRecipe.size > 0 && (
        <div className="mt-6 space-y-5 border-t border-zinc-800 pt-5">
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
                        <button
                          onClick={() => removeLink(l.id)}
                          className="text-red-400/70 hover:text-red-400 ml-4 shrink-0"
                        >
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

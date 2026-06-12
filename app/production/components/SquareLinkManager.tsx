"use client";

import React, { useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { Recipe } from "../types";
import { Modal } from "./shared";
import { usePackagingQuery, fetchJson } from "../hooks/queries";

export interface LinkRow {
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

interface SquareVariation {
  variation_id: string;
  item_id: string;
  item_name: string;
  variation_name: string;
}

type PackagingType = "keg" | "can" | "draft";

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

const TYPE_LABELS: Record<PackagingType, string> = { keg: "Keg", can: "Can", draft: "Draft" };
const TYPE_BADGE: Record<PackagingType, string> = {
  keg:   "border-orange-700 text-orange-300 bg-orange-900/30",
  can:   "border-blue-700 text-blue-300 bg-blue-900/30",
  draft: "border-emerald-700 text-emerald-300 bg-emerald-900/30",
};

// ─── Searchable combobox ───────────────────────────────────────────────────────

function VariationCombobox({
  value,
  onChange,
  variations,
  disabled,
}: {
  value: string;
  onChange: (id: string) => void;
  variations: SquareVariation[];
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen]   = useState(false);
  const wrapRef           = useRef<HTMLDivElement>(null);

  const selected    = variations.find((v) => v.variation_id === value);
  const displayName = selected
    ? `${selected.item_name}${selected.variation_name ? ` · ${selected.variation_name}` : ""}`
    : "";

  const filtered = query
    ? variations.filter((v) =>
        `${v.item_name} ${v.variation_name ?? ""}`.toLowerCase().includes(query.toLowerCase())
      )
    : variations;

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false); setQuery("");
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <div className="relative">
        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none text-xs">
          {disabled ? "" : "⌕"}
        </span>
        <input
          className="inp text-sm w-full pl-6"
          value={open ? query : displayName}
          placeholder={disabled ? "← select size first" : "Search variations…"}
          disabled={disabled}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => { if (!disabled) { setOpen(true); setQuery(""); } }}
          onKeyDown={(e) => { if (e.key === "Escape") { setOpen(false); setQuery(""); } }}
        />
        {value && !disabled && (
          <button
            type="button"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-zinc-400 text-xs leading-none"
            onMouseDown={(e) => { e.preventDefault(); onChange(""); }}
          >×</button>
        )}
      </div>

      {open && !disabled && (
        <div className="absolute z-50 left-0 right-0 mt-1 max-h-56 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl">
          {filtered.length === 0 ? (
            <div className="px-3 py-3 text-xs text-zinc-600 italic text-center">
              No matches{query ? ` for "${query}"` : ""}
            </div>
          ) : (
            filtered.map((v) => (
              <button
                key={v.variation_id}
                type="button"
                className={`w-full text-left px-3 py-2.5 text-xs transition-colors border-b border-zinc-800/40 last:border-0 ${
                  v.variation_id === value ? "bg-amber-900/30 text-amber-300" : "text-zinc-300 hover:bg-zinc-800"
                }`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(v.variation_id);
                  setOpen(false); setQuery("");
                }}
              >
                <span className="font-medium">{v.item_name}</span>
                {v.variation_name && <span className="text-zinc-500 ml-1.5">· {v.variation_name}</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main manager ─────────────────────────────────────────────────────────────

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
    queryKey: queryKeys.production.squareCatalog(),
    queryFn: () => fetchJson<SquareVariation[]>("/api/production/square-catalog"),
  });
  const { data: packagingItems = [] } = usePackagingQuery();
  const loadErr = sqError instanceof Error ? sqError.message : null;

  const [rows, setRows]           = useState<PendingRow[]>([newRow()]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [expandRecipeId, setExpandRecipeId] = useState("");

  // Quick-add: expand all packaging types for a chosen recipe in one click.
  function expandRecipe() {
    if (!expandRecipeId) return;
    const kegItems = packagingItems.filter((p) => p.type === "keg");
    const canItems = packagingItems.filter((p) => p.type === "can");
    const newRows: PendingRow[] = [
      ...kegItems.map((item) => ({
        uid: uidSeed++, recipe_id: expandRecipeId,
        packaging: "keg" as PackagingType, packaging_item_id: item.id, variation_id: "",
      })),
      ...canItems.map((item) => ({
        uid: uidSeed++, recipe_id: expandRecipeId,
        packaging: "can" as PackagingType, packaging_item_id: item.id, variation_id: "",
      })),
      { uid: uidSeed++, recipe_id: expandRecipeId, packaging: "draft" as PackagingType, packaging_item_id: "", variation_id: "" },
    ];
    setRows((rs) => {
      const isDefaultBlank = rs.length === 1 && !rs[0].recipe_id && !rs[0].variation_id;
      return isDefaultBlank ? newRows : [...rs, ...newRows];
    });
    setExpandRecipeId("");
  }

  function updateRow(uid: number, patch: Partial<PendingRow>) {
    setRows((rs) => rs.map((r) => {
      if (r.uid !== uid) return r;
      const next = { ...r, ...patch };
      if (patch.packaging && patch.packaging !== r.packaging) {
        next.packaging_item_id = ""; next.variation_id = "";
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

  const validRows = rows.filter((r) => {
    if (!r.recipe_id || !r.variation_id) return false;
    return r.packaging === "draft" ? true : !!r.packaging_item_id;
  });

  async function saveAll() {
    if (!validRows.length) return;
    setSubmitting(true); setError(null);
    try {
      await Promise.all(validRows.map((r) => {
        const sv = sqVariations.find((v) => v.variation_id === r.variation_id);
        return fetch("/api/production/recipe-square-links", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            recipe_id: r.recipe_id,
            packaging: r.packaging,
            packaging_item_id: r.packaging_item_id || null,
            square_variation_id: r.variation_id,
            square_item_id: sv?.item_id ?? null,
            variation_name: sv?.variation_name ?? null,
            item_name: sv?.item_name ?? null,
          }),
        }).then(async (res) => {
          if (!res.ok) throw new Error((await res.json()).error ?? "Error");
        });
      }));
      setRows([newRow()]); onChanged();
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
      <p className="text-xs text-zinc-500 mb-5">
        Map each recipe + packaging combination to a Square catalog variation.
        Links apply to both Taproom intake and Export.
      </p>

      {/* Quick-add: expand all packaging types for a recipe */}
      <div className="flex items-end gap-2 p-3 bg-zinc-900/40 border border-zinc-800/60 rounded-lg mb-4">
        <div className="flex-1">
          <label className="block text-[10px] text-zinc-500 uppercase tracking-wide mb-1.5">
            Quick-add — expands rows for all keg sizes, can sizes, and draft at once
          </label>
          <select
            className="inp text-sm w-full"
            value={expandRecipeId}
            onChange={(e) => setExpandRecipeId(e.target.value)}
          >
            <option value="">— choose a recipe —</option>
            {recipes.map((r) => <option key={r.id} value={r.id}>{r.beer_name}</option>)}
          </select>
        </div>
        <button
          type="button"
          onClick={expandRecipe}
          disabled={!expandRecipeId}
          className="px-3 py-1.5 text-sm bg-zinc-800 border border-zinc-700 hover:border-zinc-500 rounded text-zinc-300 disabled:opacity-30 disabled:cursor-not-allowed whitespace-nowrap transition-colors"
        >
          + Expand all packaging
        </button>
      </div>

      {/* Pending rows */}
      <div className="space-y-3 mb-4">
        {rows.map((row, idx) => {
          const subItems         = packagingItems.filter((p) => p.type === row.packaging);
          const needsPackagingItem = row.packaging === "keg" || row.packaging === "can";
          const isComplete = row.recipe_id && row.variation_id &&
            (row.packaging === "draft" ? true : !!row.packaging_item_id);

          return (
            <div
              key={row.uid}
              className={`rounded-lg border transition-colors ${
                isComplete ? "border-amber-700/40 bg-amber-950/10" : "border-zinc-800 bg-zinc-900/20"
              }`}
            >
              <div className="flex items-center justify-between px-3 pt-2.5 pb-0">
                <span className="text-[10px] text-zinc-700 font-medium uppercase tracking-wide">Link {idx + 1}</span>
                <button
                  type="button"
                  onClick={() => removeRow(row.uid)}
                  disabled={rows.length === 1}
                  className="text-zinc-700 hover:text-red-400 transition-colors text-xs disabled:opacity-20 disabled:pointer-events-none"
                >
                  Remove
                </button>
              </div>

              <div className="flex flex-col sm:flex-row items-stretch">
                {/* Left: Recipe & Packaging */}
                <div className="flex-1 px-3 pb-3 pt-2 space-y-2">
                  <p className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wide">Recipe &amp; Packaging</p>
                  <div>
                    <label className="block text-[10px] text-zinc-600 mb-1">Recipe</label>
                    <select
                      className="inp text-sm w-full"
                      value={row.recipe_id}
                      onChange={(e) => updateRow(row.uid, { recipe_id: e.target.value })}
                    >
                      <option value="">— select recipe —</option>
                      {recipes.map((r) => <option key={r.id} value={r.id}>{r.beer_name}</option>)}
                    </select>
                  </div>
                  <div className="flex gap-2">
                    <div>
                      <label className="block text-[10px] text-zinc-600 mb-1">Type</label>
                      <div className="flex rounded overflow-hidden border border-zinc-700">
                        {(["keg", "can", "draft"] as PackagingType[]).map((t, i) => (
                          <button
                            key={t}
                            type="button"
                            onClick={() => updateRow(row.uid, { packaging: t })}
                            className={`px-2.5 py-1.5 text-xs font-medium transition-colors ${i > 0 ? "border-l border-zinc-700" : ""} ${
                              row.packaging === t ? "bg-amber-600 text-white" : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"
                            }`}
                          >
                            {TYPE_LABELS[t]}
                          </button>
                        ))}
                      </div>
                    </div>

                    {needsPackagingItem && (
                      <div className="flex-1">
                        <label className="block text-[10px] text-zinc-600 mb-1">
                          {row.packaging === "keg" ? "Keg Size" : "Can Size"}
                        </label>
                        <select
                          className="inp text-sm w-full"
                          value={row.packaging_item_id}
                          onChange={(e) => updateRow(row.uid, { packaging_item_id: e.target.value })}
                          disabled={!row.recipe_id}
                        >
                          <option value="">{!row.recipe_id ? "← recipe first" : "— select size —"}</option>
                          {subItems.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}{p.volume_fl_oz ? ` (${p.volume_fl_oz} fl oz)` : ""}
                            </option>
                          ))}
                        </select>
                        {subItems.length === 0 && row.recipe_id && (
                          <p className="text-[10px] text-zinc-700 mt-0.5">
                            No {row.packaging} items — add in Inventory → Packaging
                          </p>
                        )}
                      </div>
                    )}

                    {row.packaging === "draft" && (
                      <div className="flex-1">
                        <label className="block text-[10px] text-zinc-600 mb-1">Pour size</label>
                        <p className="text-[10px] text-zinc-600 py-1.5 leading-relaxed">
                          Read from variation name<br />
                          <span className="text-zinc-500">e.g. 5oz Sample · 16oz Pint</span>
                        </p>
                      </div>
                    )}
                  </div>
                </div>

                {/* Connector — desktop */}
                <div className="hidden sm:flex flex-col items-center justify-center px-2 py-3 gap-0.5 text-zinc-700">
                  <span className="text-[9px] uppercase tracking-widest">maps</span>
                  <span className="text-[9px] uppercase tracking-widest">to</span>
                  <span className="text-base leading-none">→</span>
                </div>
                {/* Connector — mobile */}
                <div className="sm:hidden flex items-center gap-2 px-3 py-1 text-zinc-700">
                  <div className="flex-1 h-px bg-zinc-800" />
                  <span className="text-[10px] uppercase tracking-widest">maps to ↓</span>
                  <div className="flex-1 h-px bg-zinc-800" />
                </div>

                {/* Right: Square Variation */}
                <div className="flex-1 px-3 pb-3 pt-2 space-y-2 border-t sm:border-t-0 sm:border-l border-zinc-800/60">
                  <p className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wide">Square Catalog Variation</p>
                  <div>
                    <label className="block text-[10px] text-zinc-600 mb-1">Variation</label>
                    <VariationCombobox
                      value={row.variation_id}
                      onChange={(id) => updateRow(row.uid, { variation_id: id })}
                      variations={sqVariations}
                      disabled={needsPackagingItem && !row.packaging_item_id}
                    />
                  </div>
                  {row.variation_id && <p className="text-[10px] text-amber-500/80">✓ linked</p>}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {loadErr && <p className="text-xs text-red-400 mb-3">{loadErr}</p>}
      {error   && <p className="text-xs text-red-400 mb-3">{error}</p>}

      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setRows((rs) => [...rs, newRow()])}
          className="flex items-center gap-1.5 text-xs text-amber-500 hover:text-amber-400 transition-colors"
        >
          <span className="text-base leading-none">+</span>
          Add another link
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
            {submitting ? "Saving…" : validRows.length > 0 ? `Save ${validRows.length} Link${validRows.length !== 1 ? "s" : ""}` : "Save"}
          </button>
        </div>
      </div>

      {/* Existing links */}
      {byRecipe.size > 0 && (
        <div className="mt-6 space-y-4 border-t border-zinc-800 pt-5">
          <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">Existing Links</p>
          {[...byRecipe.entries()].map(([, { name, byType }]) => (
            <div key={name}>
              <p className="text-xs font-semibold text-zinc-200 mb-2">{name}</p>
              <div className="rounded-lg border border-zinc-800 overflow-hidden divide-y divide-zinc-800/60">
                {[...byType.entries()].map(([type, typeLinks]) =>
                  typeLinks.map((l) => (
                    <div key={l.id} className="flex items-center gap-3 px-3 py-2.5 text-xs">
                      <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded border font-medium ${TYPE_BADGE[type as PackagingType] ?? "border-zinc-700 text-zinc-500 bg-zinc-800"}`}>
                        {TYPE_LABELS[type as PackagingType] ?? type}
                      </span>
                      {l.packaging_items && (
                        <span className="text-zinc-300 font-medium shrink-0">
                          {l.packaging_items.name}
                          {l.packaging_items.volume_fl_oz && (
                            <span className="text-zinc-600 font-normal"> ({l.packaging_items.volume_fl_oz} fl oz)</span>
                          )}
                        </span>
                      )}
                      {l.packaging_items && <span className="text-zinc-700 shrink-0">→</span>}
                      <span className="text-zinc-400 truncate min-w-0">
                        {l.item_name ?? "—"}{l.variation_name ? ` · ${l.variation_name}` : ""}
                      </span>
                      <button
                        onClick={() => removeLink(l.id)}
                        className="ml-auto shrink-0 text-zinc-700 hover:text-red-400 transition-colors text-xs"
                      >
                        Remove
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

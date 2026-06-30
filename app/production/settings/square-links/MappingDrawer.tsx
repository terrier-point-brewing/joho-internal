"use client";

import { useState, useRef, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { useSquareMappingGridQuery, fetchJson } from "@/app/production/hooks/queries";
import type { MappingCellVariation } from "@/app/production/types";

interface SquareVariation {
  variation_id: string;
  item_id: string;
  item_name: string;
  variation_name: string;
  category_name: string | null;
}

const CATEGORY_FOR: Record<string, string> = { draft: "Draft", keg: "Kegs", can: "Cans" };

function VariationCombobox({
  value,
  onChange,
  variations,
}: {
  value: string;
  onChange: (id: string) => void;
  variations: SquareVariation[];
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const selected = variations.find((v) => v.variation_id === value);
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
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <div className="relative">
        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none text-xs">⌕</span>
        <input
          className="inp text-sm w-full pl-6"
          value={open ? query : displayName}
          placeholder="Search Square variations…"
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => { setOpen(true); setQuery(""); }}
          onKeyDown={(e) => { if (e.key === "Escape") { setOpen(false); setQuery(""); } }}
        />
        {value && (
          <button
            type="button"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-faint hover:text-secondary text-xs"
            onMouseDown={(e) => { e.preventDefault(); onChange(""); }}
          >
            ×
          </button>
        )}
      </div>
      {open && (
        <div className="absolute z-50 left-0 right-0 mt-1 max-h-56 overflow-y-auto rounded-lg border border-line-strong bg-surface shadow-xl">
          {filtered.length === 0 ? (
            <div className="px-3 py-3 text-xs text-faint italic text-center">
              No matches{query ? ` for "${query}"` : ""}
            </div>
          ) : (
            filtered.map((v) => (
              <button
                key={v.variation_id}
                type="button"
                className={`w-full text-left px-3 py-2.5 text-xs border-b border-line/40 last:border-0 transition-colors ${
                  v.variation_id === value
                    ? "bg-accent-muted/30 text-accent-soft"
                    : "text-body hover:bg-surface-mid"
                }`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(v.variation_id);
                  setOpen(false);
                  setQuery("");
                }}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span>
                    <span className="font-medium">{v.item_name}</span>
                    {v.variation_name && (
                      <span className="text-muted ml-1.5">· {v.variation_name}</span>
                    )}
                  </span>
                  {v.category_name && (
                    <span className="text-[10px] text-faint shrink-0">{v.category_name}</span>
                  )}
                </div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

interface Props {
  recipeId: string;
  colKey: string;
  onClose: () => void;
}

export default function MappingDrawer({ recipeId, colKey, onClose }: Props) {
  const qc = useQueryClient();
  const { data: gridData } = useSquareMappingGridQuery();
  const { data: sqVars = [] } = useQuery({
    queryKey: queryKeys.production.squareCatalog(),
    queryFn: () => fetchJson<SquareVariation[]>("/api/production/square-catalog"),
  });

  const [pendingSelections, setPendingSelections] = useState<Record<string, string>>({}); // variationId → squareVariationId
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  if (!gridData) return null;

  const col = gridData.columns.find((c) => c.key === colKey);
  const row = gridData.rows.find((r) => r.recipeId === recipeId);
  if (!col || !row) return null;

  const cell = row.cells[colKey];
  if (!cell) return null;

  // No category pre-filter — searching only within the column's category was hiding items
  // (e.g. a suggestion derived from square_catalog_variations might have no matching entry
  // in square_catalog_items, giving it category_name=null and excluding it from typed searches).
  // Category is shown as a label in each dropdown option so users can still identify type.
  const filteredVars = sqVars;

  async function handleAccept(v: MappingCellVariation, squareVariationId: string) {
    setSaving((s) => ({ ...s, [v.variationId]: true }));
    setErrors((e) => ({ ...e, [v.variationId]: "" }));
    try {
      const sv = sqVars.find((sv) => sv.variation_id === squareVariationId);
      const body: Record<string, unknown> = {
        recipe_id: recipeId,
        packaging: col!.type,
        square_variation_id: squareVariationId,
        square_item_id: sv?.item_id ?? null,
        variation_name: sv?.variation_name ?? null,
        item_name: sv?.item_name ?? null,
      };
      if (v.variationId !== "draft") body.variation_id = v.variationId;
      const res = await fetch("/api/production/recipe-square-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error((json as { error?: string }).error ?? "Save failed");
      }
      setPendingSelections((p) => {
        const n = { ...p };
        delete n[v.variationId];
        return n;
      });
      qc.invalidateQueries({ queryKey: ["production", "square-mapping-grid"] });
    } catch (err) {
      setErrors((e) => ({ ...e, [v.variationId]: (err as Error).message }));
    } finally {
      setSaving((s) => ({ ...s, [v.variationId]: false }));
    }
  }

  async function handleRemove(v: MappingCellVariation) {
    if (!v.linkId) return;
    setSaving((s) => ({ ...s, [v.variationId]: true }));
    try {
      const res = await fetch(`/api/production/recipe-square-links?id=${v.linkId}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Remove failed");
      qc.invalidateQueries({ queryKey: ["production", "square-mapping-grid"] });
    } catch (err) {
      setErrors((e) => ({ ...e, [v.variationId]: (err as Error).message }));
    } finally {
      setSaving((s) => ({ ...s, [v.variationId]: false }));
    }
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-30 bg-black/40"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer panel */}
      <div className="fixed inset-y-0 right-0 z-40 w-[400px] bg-canvas border-l border-line shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-line">
          <div>
            <p className="text-xs text-muted uppercase tracking-wide">Square Mapping</p>
            <p className="text-sm font-semibold text-primary mt-0.5">
              {row.recipeName} · {col.label}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-muted hover:text-strong transition-colors text-lg leading-none"
            aria-label="Close drawer"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {cell.variations.map((v) => {
            const isLinked = !!v.linkId;
            const pendingId = pendingSelections[v.variationId] ?? "";
            const isBusy = saving[v.variationId];
            const err = errors[v.variationId];

            return (
              <div key={v.variationId} className="space-y-2">
                <p className="text-xs font-semibold text-body">{v.variationName}</p>

                {isLinked ? (
                  <div className="flex items-center justify-between rounded-lg border border-success-border/40 bg-success-surface/20 px-3 py-2">
                    <span className="text-xs text-success">✓ {v.linkedSquareName}</span>
                    <button
                      onClick={() => handleRemove(v)}
                      disabled={isBusy}
                      className="text-xs text-faint hover:text-danger transition-colors disabled:opacity-30 ml-3 shrink-0"
                    >
                      Remove
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {v.suggestion &&
                      (v.suggestion.confidence === "high" || v.suggestion.confidence === "medium") && (
                        <div className="flex items-center justify-between rounded-lg border border-info-border/40 bg-info-surface/20 px-3 py-2">
                          <span className="text-xs text-info truncate mr-2">
                            Suggested: {v.suggestion.squareName}
                          </span>
                          <button
                            onClick={() => handleAccept(v, v.suggestion!.squareVariationId)}
                            disabled={isBusy}
                            className="text-xs px-2 py-1 rounded bg-info-emphasis hover:bg-info-emphasis text-primary disabled:opacity-30 shrink-0 transition-colors"
                          >
                            Accept
                          </button>
                        </div>
                      )}
                    <VariationCombobox
                      value={pendingId}
                      onChange={(id) =>
                        setPendingSelections((p) => ({ ...p, [v.variationId]: id }))
                      }
                      variations={filteredVars}
                    />
                    {pendingId && (
                      <button
                        onClick={() => handleAccept(v, pendingId)}
                        disabled={isBusy}
                        className="btn-amber text-xs w-full disabled:opacity-30"
                      >
                        {isBusy ? "Saving…" : "Link"}
                      </button>
                    )}
                    {err && <p className="text-xs text-danger">{err}</p>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

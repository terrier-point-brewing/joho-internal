"use client";

import { useState } from "react";
import { SearchCombobox } from "@/components/ui/SearchCombobox";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { useSquareMappingGridQuery, invalidateSquareMappings, patchSquareMappingCell, fetchJson } from "@/app/production/hooks/queries";
import type { MappingCellVariation } from "@/app/production/types";

interface SquareVariation {
  variation_id: string;
  item_id: string;
  item_name: string;
  variation_name: string;
  category_name: string | null;
}

/** A 409 from the link route: this Square item already belongs to other packagings. */
interface LinkConflict {
  square_variation_id: string;
  holders: { link_id: string; variation_id: string | null; variation_name: string | null }[];
}

const CATEGORY_FOR: Record<string, string> = { draft: "Draft", keg: "Kegs", can: "Cans" };

function ordinal(n: number): string {
  return n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`;
}

/** Display name for a Square variation the picker already knows about. */
function squareNameOf(squareVariationId: string, variations: SquareVariation[]): string {
  const sv = variations.find((v) => v.variation_id === squareVariationId);
  if (!sv) return "That Square item";
  return `${sv.item_name}${sv.variation_name ? ` \u00b7 ${sv.variation_name}` : ""}`;
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
  /**
   * A Square item this card asked for that another packaging already holds. The
   * API refuses the write and hands back the holders; the choice between moving
   * the mapping and selling both from one button is a person's to make, so it is
   * parked here until they make it.
   */
  const [conflicts, setConflicts] = useState<Record<string, LinkConflict>>({});

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

  async function handleAccept(
    v: MappingCellVariation,
    squareVariationId: string,
    onConflict?: "move" | "share",
  ) {
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
      if (onConflict) body.on_conflict = onConflict;
      const res = await fetch("/api/production/recipe-square-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 409) {
        // Not an error — a decision. Nothing was written; the card keeps its
        // pending selection so either answer re-sends the same request.
        const json = (await res.json().catch(() => ({}))) as { conflict?: LinkConflict };
        if (json.conflict) {
          setConflicts((c) => ({ ...c, [v.variationId]: json.conflict! }));
          return;
        }
      }
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error((json as { error?: string }).error ?? "Save failed");
      }
      // Confirmed — draw it now; the refetch below fills in the rest.
      const saved = (await res.json()) as { id: string };
      patchSquareMappingCell(qc, recipeId, colKey, v.variationId, {
        linkId: saved.id,
        linkedSquareName: sv ? `${sv.item_name}${sv.variation_name ? ` · ${sv.variation_name}` : ""}` : v.linkedSquareName,
        suggestion: null,
        ignored: false,
        ignoreId: null,
      });
      setPendingSelections((p) => {
        const n = { ...p };
        delete n[v.variationId];
        return n;
      });
      setConflicts((c) => {
        const n = { ...c };
        delete n[v.variationId];
        return n;
      });
      invalidateSquareMappings(qc);
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
      patchSquareMappingCell(qc, recipeId, colKey, v.variationId, {
        linkId: null, linkedSquareCatalogVariationId: null, linkedSquareName: null, shared: null,
      });
      invalidateSquareMappings(qc);
    } catch (err) {
      setErrors((e) => ({ ...e, [v.variationId]: (err as Error).message }));
    } finally {
      setSaving((s) => ({ ...s, [v.variationId]: false }));
    }
  }

  async function handleIgnore(v: MappingCellVariation) {
    setSaving((s) => ({ ...s, [v.variationId]: true }));
    setErrors((e) => ({ ...e, [v.variationId]: "" }));
    try {
      const body: Record<string, unknown> = { recipe_id: recipeId, packaging: col!.type };
      if (v.variationId !== "draft") body.variation_id = v.variationId;
      const res = await fetch("/api/production/recipe-square-link-ignores", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error((json as { error?: string }).error ?? "Ignore failed");
      }
      const ignore = (await res.json().catch(() => null)) as { id?: string } | null;
      patchSquareMappingCell(qc, recipeId, colKey, v.variationId, { ignored: true, ignoreId: ignore?.id ?? null });
      invalidateSquareMappings(qc);
    } catch (err) {
      setErrors((e) => ({ ...e, [v.variationId]: (err as Error).message }));
    } finally {
      setSaving((s) => ({ ...s, [v.variationId]: false }));
    }
  }

  async function handleUnignore(v: MappingCellVariation) {
    if (!v.ignoreId) return;
    setSaving((s) => ({ ...s, [v.variationId]: true }));
    try {
      const res = await fetch(`/api/production/recipe-square-link-ignores?id=${v.ignoreId}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Un-ignore failed");
      patchSquareMappingCell(qc, recipeId, colKey, v.variationId, { ignored: false, ignoreId: null });
      invalidateSquareMappings(qc);
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
            const conflict = conflicts[v.variationId];

            return (
              <div key={v.variationId} className="space-y-2">
                <p className="text-xs font-semibold text-body">{v.variationName}</p>

                {isLinked ? (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between rounded-lg border border-success-border/40 bg-success-surface/20 px-3 py-2">
                      <span className="text-xs text-success">✓ {v.linkedSquareName}</span>
                      <button
                        onClick={() => handleRemove(v)}
                        disabled={isBusy}
                        className="btn-danger ml-3 shrink-0"
                      >
                        Remove
                      </button>
                    </div>
                    {v.shared && (
                      <div className="rounded-lg border border-info-border/40 bg-info-surface/20 px-3 py-2 space-y-0.5">
                        <p className="text-xs text-info">
                          Shared with {v.shared.withNames.join(", ")}
                        </p>
                        <p className="text-[11px] text-muted">
                          {v.shared.pourRank === 1
                            ? `Pours next — ${v.shared.onHand} on hand`
                            : v.shared.pourRank != null
                              ? `Pours ${ordinal(v.shared.pourRank)} — ${v.shared.onHand} on hand`
                              : "Nothing on hand — skipped until it's packaged again"}
                        </p>
                      </div>
                    )}
                  </div>
                ) : v.ignored ? (
                  <div className="flex items-center justify-between rounded-lg border border-line bg-surface-mid/40 px-3 py-2">
                    <span className="text-xs text-muted">Ignored — no Square mapping needed</span>
                    <button
                      onClick={() => handleUnignore(v)}
                      disabled={isBusy}
                      className="btn-secondary ml-3 shrink-0"
                    >
                      Require mapping
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
                            className="btn-primary shrink-0"
                          >
                            Accept
                          </button>
                        </div>
                      )}
                    <SearchCombobox
                      value={pendingId}
                      placeholder="Search Square variations…"
                      onChange={(id) => {
                        setPendingSelections((p) => ({ ...p, [v.variationId]: id }));
                        // A new pick is a new question — drop the answer pending
                        // on the old one.
                        setConflicts((c) => {
                          const n = { ...c };
                          delete n[v.variationId];
                          return n;
                        });
                      }}
                      items={filteredVars.map((sv) => ({
                        id: sv.variation_id,
                        label: sv.item_name,
                        sub: sv.variation_name,
                        hint: sv.category_name,
                      }))}
                    />
                    {conflict ? (
                      <div className="rounded-lg border border-accent-border/40 bg-accent-muted/20 px-3 py-2 space-y-2">
                        <p className="text-xs text-accent-soft">
                          {squareNameOf(conflict.square_variation_id, sqVars)} is already linked to{" "}
                          {conflict.holders.map((h) => h.variation_name ?? "another packaging").join(", ")}.
                        </p>
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleAccept(v, conflict.square_variation_id, "share")}
                            disabled={isBusy}
                            className="btn-primary flex-1"
                          >
                            {isBusy ? "Saving…" : "Sell both from it"}
                          </button>
                          <button
                            onClick={() => handleAccept(v, conflict.square_variation_id, "move")}
                            disabled={isBusy}
                            className="btn-secondary flex-1"
                          >
                            Move it here
                          </button>
                        </div>
                        <p className="text-[11px] text-muted">Oldest stock sells first.</p>
                      </div>
                    ) : pendingId ? (
                      <button
                        onClick={() => handleAccept(v, pendingId)}
                        disabled={isBusy}
                        className="btn-primary w-full"
                      >
                        {isBusy ? "Saving…" : "Link"}
                      </button>
                    ) : null}
                    <button
                      onClick={() => handleIgnore(v)}
                      disabled={isBusy}
                      className="btn-danger w-full"
                    >
                      {isBusy ? "Saving…" : "Ignore — no Square mapping needed"}
                    </button>
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

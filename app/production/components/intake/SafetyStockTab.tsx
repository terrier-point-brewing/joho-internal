"use client";

import { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { Recipe, BatchTransfer, Equipment, BrewBatch, SafetyStockFloor, PackagingItem } from "../../types";
import { coldStorageLots } from "../../lib/coldStorage";
import { fetchJson, usePackagingQuery } from "../../hooks/queries";
import { BBL_TO_FL_OZ } from "@/lib/constants/production";

export default function SafetyStockTab({
  recipes, transfers, tanks, batches,
}: {
  recipes: Recipe[];
  transfers: BatchTransfer[];
  tanks: Equipment[];
  batches: BrewBatch[];
}) {
  const qc = useQueryClient();
  const { data: floors = [] } = useQuery({
    queryKey: queryKeys.production.safetyStock(),
    queryFn: () => fetchJson<SafetyStockFloor[]>("/api/production/safety-stock"),
  });
  const { data: packagingItems = [] } = usePackagingQuery();
  const loadFloors = () => qc.invalidateQueries({ queryKey: queryKeys.production.safetyStock() });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  // On-hand BBL per recipe (summed across keg + can).
  const onHandBblByRecipe = useMemo(() => {
    // Build a default packaging item lookup by type for BBL conversion.
    const pkgByType = new Map<string, PackagingItem>();
    for (const p of packagingItems) {
      if (p.volume_fl_oz && !pkgByType.has(p.type)) pkgByType.set(p.type, p);
    }

    const map = new Map<string, number>();
    for (const lot of coldStorageLots(transfers, tanks, batches)) {
      const recipeId = lot.batch?.recipe_id;
      if (!recipeId) continue;
      const netQty = lot.initialQty;
      if (netQty <= 0) continue;
      const pkg = pkgByType.get(lot.packaging);
      const bbl = pkg?.volume_fl_oz ? (netQty * pkg.volume_fl_oz) / BBL_TO_FL_OZ : 0;
      map.set(recipeId, (map.get(recipeId) ?? 0) + bbl);
    }
    return map;
  }, [transfers, tanks, batches, packagingItems]);

  async function saveFloor(recipeId: string) {
    const value = drafts[recipeId];
    if (value == null || value === "") return;
    setSavingId(recipeId);
    try {
      const res = await fetch("/api/production/safety-stock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Store with packaging="keg" as a canonical placeholder; floor_quantity is BBL.
        body: JSON.stringify({ recipe_id: recipeId, packaging: "keg", floor_quantity: parseFloat(value) }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      await loadFloors();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Error");
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div>
      <p className="text-sm text-muted mb-4">
        Minimum BBL floor per style. The demand calendar uses these floors to flag reorder urgency.
      </p>
      {recipes.length === 0 ? (
        <p className="text-faint text-sm py-10 text-center">No recipes found.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface/50 text-left">
                <th className="px-4 py-2.5 text-xs font-medium text-muted">Style</th>
                <th className="px-4 py-2.5 text-xs font-medium text-muted text-right">On Hand (BBL)</th>
                <th className="px-4 py-2.5 text-xs font-medium text-muted">Safety Floor (BBL)</th>
                <th className="px-4 py-2.5 text-xs font-medium text-muted"></th>
              </tr>
            </thead>
            <tbody>
              {[...recipes].sort((a, b) => a.beer_name.localeCompare(b.beer_name)).map((recipe, i) => {
                const floor = floors.find((f) => f.recipe_id === recipe.id);
                const draft = drafts[recipe.id] ?? (floor != null ? String(floor.floor_quantity) : "");
                const onHand = onHandBblByRecipe.get(recipe.id) ?? 0;
                const below = floor != null && onHand < floor.floor_quantity;
                return (
                  <tr key={recipe.id} className={`border-b border-line/60 last:border-0 ${i % 2 !== 0 ? "bg-surface/30" : ""}`}>
                    <td className="px-4 py-2.5 text-primary font-medium">{recipe.style ?? recipe.beer_name}</td>
                    <td className={`px-4 py-2.5 text-right tabular-nums ${below ? "text-danger" : onHand > 0 ? "text-success" : "text-faint"}`}>
                      {onHand.toFixed(2)}
                    </td>
                    <td className="px-4 py-2.5">
                      <input
                        type="number" step="0.1" min="0" className="inp-sm max-w-[120px]"
                        placeholder="0.0"
                        value={draft}
                        onChange={(e) => setDrafts((d) => ({ ...d, [recipe.id]: e.target.value }))}
                      />
                    </td>
                    <td className="px-4 py-2.5">
                      <button
                        onClick={() => saveFloor(recipe.id)}
                        disabled={savingId === recipe.id || draft === ""}
                        className="btn-primary btn-xxs"
                      >
                        {savingId === recipe.id ? "Saving…" : "Save"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { Recipe, BatchTransfer, Equipment, BrewBatch, SafetyStockFloor, BrewInventoryAdjustment } from "../../types";
import { coldStorageLots } from "../../lib/coldStorage";

type Pkg = "keg" | "can";

interface Row {
  recipe_id: string;
  style: string;
  packaging: Pkg;
  onHand: number;
}

export default function SafetyStockTab({
  recipes, transfers, tanks, batches,
}: {
  recipes: Recipe[];
  transfers: BatchTransfer[];
  tanks: Equipment[];
  batches: BrewBatch[];
}) {
  const [floors, setFloors] = useState<SafetyStockFloor[]>([]);
  const [adjustments, setAdjustments] = useState<BrewInventoryAdjustment[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const loadFloors = useCallback(async () => {
    const r = await fetch("/api/production/safety-stock");
    if (r.ok) setFloors(await r.json());
  }, []);
  useEffect(() => { loadFloors(); }, [loadFloors]);

  useEffect(() => {
    (async () => {
      const r = await fetch("/api/production/brew-adjustments");
      if (r.ok) setAdjustments(await r.json());
    })();
  }, []);

  const recipeName = useMemo(() => new Map(recipes.map((r) => [r.id, r.beer_name])), [recipes]);

  // Aggregate cold-storage on-hand per recipe × packaging.
  const rows: Row[] = useMemo(() => {
    const adjByTransfer = new Map<string, number>();
    for (const a of adjustments) {
      adjByTransfer.set(a.batch_transfer_id, (adjByTransfer.get(a.batch_transfer_id) ?? 0) + Number(a.quantity));
    }
    const lots = coldStorageLots(transfers, tanks, batches);
    const agg = new Map<string, Row>();
    for (const lot of lots) {
      const recipeId = lot.batch?.recipe_id;
      if (!recipeId) continue;
      const key = `${recipeId}:${lot.packaging}`;
      const onHand = lot.initialQty + (adjByTransfer.get(lot.transfer.id) ?? 0);
      const existing = agg.get(key);
      if (existing) existing.onHand += onHand;
      else agg.set(key, { recipe_id: recipeId, style: recipeName.get(recipeId) ?? lot.batch?.beer_name ?? "—", packaging: lot.packaging, onHand });
    }
    // Include floors that have no current stock so they stay visible/editable.
    for (const f of floors) {
      const key = `${f.recipe_id}:${f.packaging}`;
      if (!agg.has(key)) {
        agg.set(key, { recipe_id: f.recipe_id, style: recipeName.get(f.recipe_id) ?? "—", packaging: f.packaging, onHand: 0 });
      }
    }
    return [...agg.values()].sort((a, b) => a.style.localeCompare(b.style) || a.packaging.localeCompare(b.packaging));
  }, [transfers, tanks, batches, adjustments, floors, recipeName]);

  const floorFor = useCallback(
    (recipeId: string, pkg: Pkg) => floors.find((f) => f.recipe_id === recipeId && f.packaging === pkg)?.floor_quantity ?? null,
    [floors],
  );

  async function saveFloor(recipeId: string, pkg: Pkg) {
    const key = `${recipeId}:${pkg}`;
    const value = drafts[key];
    if (value == null || value === "") return;
    setSavingKey(key);
    try {
      const res = await fetch("/api/production/safety-stock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipe_id: recipeId, packaging: pkg, floor_quantity: parseFloat(value) }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      await loadFloors();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Error");
    } finally {
      setSavingKey(null);
    }
  }

  const COLS = ["Style", "Packaging", "On Hand (cold storage)", "Safety Floor", ""];

  return (
    <div>
      <p className="text-sm text-zinc-500 mb-4">Current cold-storage inventory by style and packaging, with designated safety stock floors.</p>
      {rows.length === 0 ? (
        <p className="text-zinc-600 text-sm py-10 text-center">No kegged or canned inventory in cold storage yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900/50 text-left">
                {COLS.map((h, i) => <th key={i} className={`px-4 py-2.5 text-xs font-medium text-zinc-500 ${i === 2 ? "text-right" : ""}`}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => {
                const key = `${row.recipe_id}:${row.packaging}`;
                const floor = floorFor(row.recipe_id, row.packaging);
                const draft = drafts[key] ?? (floor != null ? String(floor) : "");
                const below = floor != null && row.onHand < floor;
                return (
                  <tr key={key} className={`border-b border-zinc-800/60 ${i % 2 !== 0 ? "bg-zinc-900/30" : ""}`}>
                    <td className="px-4 py-2.5 text-zinc-100 font-medium">{row.style}</td>
                    <td className="px-4 py-2.5 text-zinc-400 capitalize">{row.packaging}</td>
                    <td className={`px-4 py-2.5 text-right tabular-nums ${below ? "text-red-400" : "text-green-400"}`}>{row.onHand}</td>
                    <td className="px-4 py-2.5">
                      <input type="number" step="1" min="0" className="inp max-w-[120px]"
                        value={draft}
                        onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))} />
                    </td>
                    <td className="px-4 py-2.5">
                      <button onClick={() => saveFloor(row.recipe_id, row.packaging)} disabled={savingKey === key}
                        className="text-xs text-amber-500 hover:text-amber-400 font-medium disabled:opacity-50">
                        {savingKey === key ? "Saving…" : "Save"}
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

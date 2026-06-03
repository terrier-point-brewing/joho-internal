"use client";

import { useState } from "react";
import { Ingredient, StockAdjustment, PackagingItem, BatchTransfer, Equipment, BrewBatch } from "../types";
import IngredientsTab from "./IngredientsTab";
import PackagingTab   from "./PackagingTab";
import BrewsSubtab    from "./BrewsSubtab";

type SubTab = "ingredients" | "packaging" | "brews";

export default function InventoryTab({
  ingredients,
  adjustments,
  packaging,
  transfers,
  tanks,
  batches,
  onRefreshIngredients,
  onRefreshAdjustments,
  onRefreshPackaging,
}: {
  ingredients: Ingredient[];
  adjustments: StockAdjustment[];
  packaging: PackagingItem[];
  transfers: BatchTransfer[];
  tanks: Equipment[];
  batches: BrewBatch[];
  onRefreshIngredients: () => Promise<void>;
  onRefreshAdjustments: () => Promise<void>;
  onRefreshPackaging: () => Promise<void>;
}) {
  const [sub, setSub] = useState<SubTab>("ingredients");

  return (
    <>
      {/* Header */}
      <div className="mb-4">
        <h2 className="text-base font-medium text-zinc-100">Inventory</h2>
        <p className="text-sm text-zinc-500 mt-0.5">Ingredients, packaging materials, and brew inventory</p>
      </div>

      {/* Sub-tab bar */}
      <div className="flex gap-1 mb-6 border-b border-zinc-800">
        {(["ingredients", "packaging", "brews"] as SubTab[]).map((t) => (
          <button
            key={t}
            onClick={() => setSub(t)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px capitalize ${
              sub === t
                ? "border-amber-500 text-zinc-100"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {sub === "ingredients" && (
        <IngredientsTab
          ingredients={ingredients}
          adjustments={adjustments}
          onRefresh={onRefreshIngredients}
          onAdjustmentsRefresh={onRefreshAdjustments}
        />
      )}
      {sub === "packaging" && (
        <PackagingTab packaging={packaging} onRefresh={onRefreshPackaging} />
      )}
      {sub === "brews" && (
        <BrewsSubtab transfers={transfers} tanks={tanks} batches={batches} />
      )}
    </>
  );
}

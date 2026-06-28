"use client";

import { useState } from "react";
import IngredientsTab      from "./IngredientsTab";
import PackagingTab        from "./PackagingTab";
import StockAdjustmentsTab from "./StockAdjustmentsTab";

type SubTab = "ingredients" | "packaging" | "adjustments";

const SUBTAB_LABELS: Record<SubTab, string> = {
  ingredients: "Ingredients",
  packaging:   "Packaging",
  adjustments: "Stock Adjustments",
};

export default function InventoryTab() {
  const [sub, setSub] = useState<SubTab>("ingredients");

  return (
    <>
      {/* Header */}
      <div className="mt-4 mb-4">
        <h2 className="text-base font-medium text-zinc-100">Inventory</h2>
        <p className="text-sm text-zinc-500 mt-0.5">Ingredients, packaging materials, and stock adjustments</p>
      </div>

      {/* Sub-tab bar */}
      <div className="flex gap-1 mb-6 border-b border-zinc-800 sticky top-[5.25rem] md:static z-30 bg-zinc-950/95 -mx-4 sm:mx-0 px-4 sm:px-0 overflow-x-auto overflow-y-hidden scrollbar-none">
        {(["ingredients", "packaging", "adjustments"] as SubTab[]).map((t) => (
          <button
            key={t}
            onClick={() => setSub(t)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px whitespace-nowrap ${
              sub === t
                ? "border-amber-500 text-zinc-100"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {SUBTAB_LABELS[t]}
          </button>
        ))}
      </div>

      {sub === "ingredients"  && <IngredientsTab />}
      {sub === "packaging"    && <PackagingTab />}
      {sub === "adjustments"  && <StockAdjustmentsTab />}
    </>
  );
}

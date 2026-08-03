"use client";

import IngredientsTab      from "./IngredientsTab";
import PackagingTab        from "./PackagingTab";
import StockAdjustmentsTab from "./StockAdjustmentsTab";
import type { InventorySubtab } from "../inventory/page";

export default function InventoryTab({ sub }: { sub: InventorySubtab }) {
  return (
    <>
      {sub === "ingredients"  && <IngredientsTab />}
      {sub === "packaging"    && <PackagingTab />}
      {sub === "adjustments"  && <StockAdjustmentsTab />}
    </>
  );
}

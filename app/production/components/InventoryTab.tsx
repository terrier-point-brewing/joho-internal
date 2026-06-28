"use client";

import { useState } from "react";
import IngredientsTab      from "./IngredientsTab";
import PackagingTab        from "./PackagingTab";
import StockAdjustmentsTab from "./StockAdjustmentsTab";
import TabBar, { type TabDef } from "@/app/components/TabBar";

type SubTab = "ingredients" | "packaging" | "adjustments";

const SUBTABS: TabDef<SubTab>[] = [
  { key: "ingredients", label: "Ingredients" },
  { key: "packaging",   label: "Packaging" },
  { key: "adjustments", label: "Stock Adjustments" },
];

export default function InventoryTab() {
  const [sub, setSub] = useState<SubTab>("ingredients");

  return (
    <>
      <TabBar tabs={SUBTABS} activeKey={sub} onSelect={setSub} sticky />

      {sub === "ingredients"  && <IngredientsTab />}
      {sub === "packaging"    && <PackagingTab />}
      {sub === "adjustments"  && <StockAdjustmentsTab />}
    </>
  );
}

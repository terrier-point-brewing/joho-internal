"use client";
import { useState } from "react";
import SubNav from "@/app/components/SubNav";
import PageHeader from "@/app/components/PageHeader";
import StickyHeader from "@/app/components/StickyHeader";
import TabBar, { type TabDef } from "@/app/components/TabBar";
import { PRODUCTION_NAV } from "@/app/production/nav-config";
import InventoryTab from "@/app/production/components/InventoryTab";

export type InventorySubtab = "ingredients" | "packaging" | "adjustments";

const SUBTABS: TabDef<InventorySubtab>[] = [
  { key: "ingredients", label: "Ingredients" },
  { key: "packaging",   label: "Packaging" },
  { key: "adjustments", label: "Stock Adjustments" },
];

export default function InventoryPage() {
  const [sub, setSub] = useState<InventorySubtab>("ingredients");

  return (
    <main className="px-4 sm:px-6">
      <StickyHeader>
        <SubNav entries={PRODUCTION_NAV} mobile />
        <PageHeader
          title="Inventory"
          description="Ingredients, packaging materials, and stock adjustments"
        />
        <TabBar tabs={SUBTABS} activeKey={sub} onSelect={setSub} className="mb-0" />
      </StickyHeader>
      <div className="mt-6 pb-4 sm:pb-8"><InventoryTab sub={sub} /></div>
    </main>
  );
}

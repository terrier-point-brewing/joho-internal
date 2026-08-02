"use client";
import SubNav from "@/app/components/SubNav";
import PageHeader from "@/app/components/PageHeader";
import StickyHeader from "@/app/components/StickyHeader";
import { PRODUCTION_NAV } from "@/app/production/nav-config";
import InventoryTab from "@/app/production/components/InventoryTab";

export default function InventoryPage() {
  return (
    <main className="px-4 sm:px-6">
      <StickyHeader>
        <SubNav entries={PRODUCTION_NAV} mobile />
        <PageHeader
          title="Inventory"
          description="Ingredients, packaging materials, and stock adjustments"
        />
      </StickyHeader>
      <div className="mt-4 pb-4 sm:pb-8"><InventoryTab /></div>
    </main>
  );
}

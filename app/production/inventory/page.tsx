"use client";
import SubNav from "@/app/components/SubNav";
import PageHeader from "@/app/components/PageHeader";
import { PRODUCTION_NAV } from "@/app/production/nav-config";
import InventoryTab from "@/app/production/components/InventoryTab";

export default function InventoryPage() {
  return (
    <main className="px-4 sm:px-6 py-4 sm:py-8">
      <SubNav entries={PRODUCTION_NAV} mobile sticky />
      <PageHeader
        title="Inventory"
        description="Ingredients, packaging materials, and stock adjustments"
      />
      <InventoryTab />
    </main>
  );
}

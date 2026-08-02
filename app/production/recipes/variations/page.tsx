"use client";
import SubNav from "@/app/components/SubNav";
import { PRODUCTION_NAV, RECIPES_NAV } from "@/app/production/nav-config";
import PackagingVariationsPanel from "@/app/production/components/PackagingVariationsPanel";
import PageHeader from "@/app/components/PageHeader";
import StickyHeader from "@/app/components/StickyHeader";

export default function PackagingVariationsPage() {
  return (
    <main className="px-4 sm:px-6">
      <StickyHeader>
        <SubNav entries={PRODUCTION_NAV} mobile />
        <PageHeader title="Recipes" description="Beer recipes, packaging variations, and brew step templates" />
        <SubNav entries={RECIPES_NAV} />
      </StickyHeader>
      <div className="mt-4 pb-4 sm:pb-8"><PackagingVariationsPanel /></div>
    </main>
  );
}

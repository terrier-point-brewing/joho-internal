"use client";
import SubNav from "@/app/components/SubNav";
import { PRODUCTION_NAV, RECIPES_NAV } from "@/app/production/nav-config";
import RecipesTab from "@/app/production/components/RecipesTab";
import PageHeader from "@/app/components/PageHeader";

export default function RecipesPage() {
  return (
    <main className="px-4 sm:px-6 py-4 sm:py-8">
      <SubNav entries={PRODUCTION_NAV} mobile sticky />
      <PageHeader title="Recipes" description="Beer recipes, packaging variations, and brew step templates" />
      <SubNav entries={RECIPES_NAV} sticky />
      <div className="mt-4"><RecipesTab /></div>
    </main>
  );
}

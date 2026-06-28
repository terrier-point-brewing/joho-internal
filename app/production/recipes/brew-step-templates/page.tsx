"use client";
import SubNav from "@/app/components/SubNav";
import { PRODUCTION_NAV, RECIPES_NAV } from "@/app/production/nav-config";
import BrewStepTemplatesTab from "@/app/production/components/BrewStepTemplatesTab";

export default function BrewStepTemplatesPage() {
  return (
    <main className="px-4 sm:px-6 py-4 sm:py-8">
      <SubNav entries={PRODUCTION_NAV} mobile sticky />
      <div className="mt-4 mb-2">
        <h2 className="text-base font-medium text-zinc-100">Recipes</h2>
        <p className="text-sm text-zinc-500 mt-0.5">Beer recipes, packaging variations, and brew step templates</p>
      </div>
      <SubNav entries={RECIPES_NAV} sticky />
      <div className="mt-4"><BrewStepTemplatesTab /></div>
    </main>
  );
}

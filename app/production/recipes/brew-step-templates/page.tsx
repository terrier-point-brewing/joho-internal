"use client";
import SubNav from "@/app/components/SubNav";
import { PRODUCTION_NAV, RECIPES_NAV } from "@/app/production/nav-config";
import BrewStepTemplatesTab from "@/app/production/components/BrewStepTemplatesTab";

export default function BrewStepTemplatesPage() {
  return (
    <main className="px-4 sm:px-6 py-4 sm:py-8">
      <SubNav entries={PRODUCTION_NAV} mobile sticky />
      <SubNav entries={RECIPES_NAV} sticky />
      <BrewStepTemplatesTab />
    </main>
  );
}

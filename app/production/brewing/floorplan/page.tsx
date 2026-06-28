"use client";
import SubNav from "@/app/components/SubNav";
import { PRODUCTION_NAV, BREWING_NAV } from "@/app/production/nav-config";
import BrewStatusTab from "@/app/production/components/BrewStatusTab";
import PageHeader from "@/app/components/PageHeader";

export default function FloorplanPage() {
  return (
    <main className="px-4 sm:px-6 py-4 sm:py-8">
      <SubNav entries={PRODUCTION_NAV} mobile sticky />
      <PageHeader title="Brewing" description="Batch tracking, fermentation monitoring, and equipment scheduling" />
      <SubNav entries={BREWING_NAV} sticky />
      <div className="mt-4"><BrewStatusTab /></div>
    </main>
  );
}

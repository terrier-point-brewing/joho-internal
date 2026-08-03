"use client";
import SubNav from "@/app/components/SubNav";
import { PRODUCTION_NAV, BREWING_NAV } from "@/app/production/nav-config";
import GanttTab from "@/app/production/components/GanttTab";
import PageHeader from "@/app/components/PageHeader";
import StickyHeader from "@/app/components/StickyHeader";

export default function TimelinePage() {
  return (
    <main className="px-4 sm:px-6">
      <StickyHeader>
        <SubNav entries={PRODUCTION_NAV} mobile />
        <PageHeader title="Brewing" description="Batch tracking, fermentation monitoring, and equipment scheduling" />
        <SubNav entries={BREWING_NAV} />
      </StickyHeader>
      <div className="mt-6 pb-4 sm:pb-8"><GanttTab /></div>
    </main>
  );
}

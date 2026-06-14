"use client";
import SubNav from "@/app/components/SubNav";
import { PRODUCTION_NAV, BREWING_NAV } from "@/app/production/nav-config";
import GanttTab from "@/app/production/components/GanttTab";

export default function TimelinePage() {
  return (
    <main className="px-4 sm:px-6 py-4 sm:py-8">
      <SubNav entries={PRODUCTION_NAV} mobile sticky />
      <SubNav entries={BREWING_NAV} sticky />
      <GanttTab />
    </main>
  );
}

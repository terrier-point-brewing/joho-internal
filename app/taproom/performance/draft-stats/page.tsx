"use client";
import SubNav from "@/app/components/SubNav";
import { TAPROOM_NAV, PERFORMANCE_NAV } from "@/app/taproom/nav-config";
import DraftStatsTab from "@/app/taproom/components/DraftStatsTab";

export default function DraftStatsPage() {
  return (
    <main className="px-4 sm:px-6 py-4 sm:py-8">
      <SubNav entries={TAPROOM_NAV} mobile />
      <SubNav entries={PERFORMANCE_NAV} sticky />
      <DraftStatsTab />
    </main>
  );
}

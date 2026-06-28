"use client";
import SubNav from "@/app/components/SubNav";
import PageHeader from "@/app/components/PageHeader";
import { TAPROOM_NAV, TARGETS_NAV } from "@/app/taproom/nav-config";
import ManualEntriesTab from "@/app/taproom/components/ManualEntriesTab";

export default function ManualEntriesPage() {
  return (
    <main className="px-4 sm:px-6 py-4 sm:py-8">
      <SubNav entries={TAPROOM_NAV} mobile />
      <PageHeader title="Targets" description="Sales goals, achievement tracking, and manual entries" />
      <SubNav entries={TARGETS_NAV} sticky />
      <ManualEntriesTab />
    </main>
  );
}

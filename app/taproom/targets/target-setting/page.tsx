"use client";
import SubNav from "@/app/components/SubNav";
import PageHeader from "@/app/components/PageHeader";
import { TAPROOM_NAV, TARGETS_NAV } from "@/app/taproom/nav-config";
import TargetSettingTab from "@/app/taproom/components/TargetSettingTab";

export default function TargetSettingPage() {
  return (
    <main className="px-4 sm:px-6 py-4 sm:py-8">
      <SubNav entries={TAPROOM_NAV} mobile />
      <PageHeader title="Targets" description="Sales goals, achievement tracking, and manual entries" />
      <SubNav entries={TARGETS_NAV} sticky />
      <TargetSettingTab />
    </main>
  );
}

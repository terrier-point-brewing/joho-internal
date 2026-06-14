"use client";
import SubNav from "@/app/components/SubNav";
import { TAPROOM_NAV, TARGETS_NAV } from "@/app/taproom/nav-config";
import ManualEntriesTab from "@/app/taproom/components/ManualEntriesTab";

export default function ManualEntriesPage() {
  return (
    <main className="px-4 sm:px-6 py-4 sm:py-8">
      <SubNav entries={TAPROOM_NAV} mobile />
      <SubNav entries={TARGETS_NAV} sticky />
      <ManualEntriesTab />
    </main>
  );
}

"use client";
import SubNav from "@/app/components/SubNav";
import { PRODUCTION_NAV, BREWING_NAV } from "@/app/production/nav-config";
import BatchLogTab from "@/app/production/components/BatchLogTab";

export default function BatchLogPage() {
  return (
    <main className="px-4 sm:px-6 py-4 sm:py-8">
      <SubNav entries={PRODUCTION_NAV} mobile sticky />
      <SubNav entries={BREWING_NAV} sticky />
      <BatchLogTab />
    </main>
  );
}

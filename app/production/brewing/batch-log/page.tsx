"use client";
import SubNav from "@/app/components/SubNav";
import { PRODUCTION_NAV, BREWING_NAV } from "@/app/production/nav-config";
import BatchLogTab from "@/app/production/components/BatchLogTab";

export default function BatchLogPage() {
  return (
    <main className="px-4 sm:px-6 py-4 sm:py-8">
      <SubNav entries={PRODUCTION_NAV} mobile sticky />
      <div className="mt-4 mb-2">
        <h2 className="text-base font-medium text-zinc-100">Brewing</h2>
        <p className="text-sm text-zinc-500 mt-0.5">Batch tracking, fermentation monitoring, and equipment scheduling</p>
      </div>
      <SubNav entries={BREWING_NAV} sticky />
      <div className="mt-4"><BatchLogTab /></div>
    </main>
  );
}

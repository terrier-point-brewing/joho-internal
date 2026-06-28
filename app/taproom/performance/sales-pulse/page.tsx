"use client";
import SubNav from "@/app/components/SubNav";
import PageHeader from "@/app/components/PageHeader";
import { TAPROOM_NAV, PERFORMANCE_NAV } from "@/app/taproom/nav-config";
import SalesPulseTab from "@/app/taproom/components/SalesPulseTab";

export default function SalesPulsePage() {
  return (
    <main className="px-4 sm:px-6 py-4 sm:py-8">
      <SubNav entries={TAPROOM_NAV} mobile />
      <PageHeader title="Performance" description="Sales trends, draft throughput, and event summaries" />
      <SubNav entries={PERFORMANCE_NAV} sticky />
      <div className="mt-4"><SalesPulseTab /></div>
    </main>
  );
}

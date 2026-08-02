"use client";
import SubNav from "@/app/components/SubNav";
import PageHeader from "@/app/components/PageHeader";
import StickyHeader from "@/app/components/StickyHeader";
import { PRODUCTION_NAV } from "@/app/production/nav-config";
import PartnersTab from "@/app/production/components/PartnersTab";

export default function PartnersPage() {
  return (
    <main className="px-4 sm:px-6">
      <StickyHeader>
        <SubNav entries={PRODUCTION_NAV} mobile />
        <PageHeader
          title="Partners"
          description="Contract brewing partners and ingredient/packaging suppliers"
        />
      </StickyHeader>
      <div className="mt-4 pb-4 sm:pb-8"><PartnersTab /></div>
    </main>
  );
}

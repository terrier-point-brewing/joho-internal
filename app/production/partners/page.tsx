"use client";
import SubNav from "@/app/components/SubNav";
import PageHeader from "@/app/components/PageHeader";
import { PRODUCTION_NAV } from "@/app/production/nav-config";
import PartnersTab from "@/app/production/components/PartnersTab";

export default function PartnersPage() {
  return (
    <main className="px-4 sm:px-6 py-4 sm:py-8">
      <SubNav entries={PRODUCTION_NAV} mobile sticky />
      <PageHeader
        title="Partners"
        description="Contract brewing partners and ingredient/packaging suppliers"
      />
      <PartnersTab />
    </main>
  );
}

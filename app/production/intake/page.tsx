"use client";
import SubNav from "@/app/components/SubNav";
import PageHeader from "@/app/components/PageHeader";
import StickyHeader from "@/app/components/StickyHeader";
import { PRODUCTION_NAV } from "@/app/production/nav-config";
import IntakeTab from "@/app/production/components/IntakeTab";

export default function IntakePage() {
  return (
    <main className="px-4 sm:px-6">
      <StickyHeader>
        <SubNav entries={PRODUCTION_NAV} mobile />
        <PageHeader
          title="Intake"
          description="Demand planning across taproom, distribution, and contract brewing"
        />
      </StickyHeader>
      <div className="mt-4 pb-4 sm:pb-8"><IntakeTab /></div>
    </main>
  );
}

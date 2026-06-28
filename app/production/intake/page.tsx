"use client";
import SubNav from "@/app/components/SubNav";
import PageHeader from "@/app/components/PageHeader";
import { PRODUCTION_NAV } from "@/app/production/nav-config";
import IntakeTab from "@/app/production/components/IntakeTab";

export default function IntakePage() {
  return (
    <main className="px-4 sm:px-6 py-4 sm:py-8">
      <SubNav entries={PRODUCTION_NAV} mobile sticky />
      <PageHeader
        title="Intake"
        description="Demand planning across taproom, distribution, and contract brewing"
      />
      <IntakeTab />
    </main>
  );
}

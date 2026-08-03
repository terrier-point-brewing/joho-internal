"use client";
import { useState } from "react";
import SubNav from "@/app/components/SubNav";
import PageHeader from "@/app/components/PageHeader";
import StickyHeader from "@/app/components/StickyHeader";
import TabBar, { type TabDef } from "@/app/components/TabBar";
import { PRODUCTION_NAV } from "@/app/production/nav-config";
import IntakeTab from "@/app/production/components/IntakeTab";

export type IntakeSubtab = "taproom" | "commitments" | "safety" | "demand" | "scheduler";

const SUBTABS: TabDef<IntakeSubtab>[] = [
  { key: "taproom",     label: "Taproom" },
  { key: "commitments", label: "Commitments" },
  { key: "safety",      label: "Safety Stock" },
  { key: "demand",      label: "Demand Calendar" },
  { key: "scheduler",   label: "Batch Scheduler" },
];

export default function IntakePage() {
  const [sub, setSub] = useState<IntakeSubtab>("taproom");

  return (
    <main className="px-4 sm:px-6">
      <StickyHeader>
        <SubNav entries={PRODUCTION_NAV} mobile />
        <PageHeader
          title="Intake"
          description="Demand planning across taproom, distribution, and contract brewing"
        />
        <TabBar tabs={SUBTABS} activeKey={sub} onSelect={setSub} className="mb-0" />
      </StickyHeader>
      <div className="mt-6 pb-4 sm:pb-8"><IntakeTab sub={sub} /></div>
    </main>
  );
}

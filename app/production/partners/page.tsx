"use client";
import { useState } from "react";
import SubNav from "@/app/components/SubNav";
import PageHeader from "@/app/components/PageHeader";
import StickyHeader from "@/app/components/StickyHeader";
import TabBar, { type TabDef } from "@/app/components/TabBar";
import { PRODUCTION_NAV } from "@/app/production/nav-config";
import PartnersTab from "@/app/production/components/PartnersTab";

export type PartnerKind = "contract" | "supplier";

export default function PartnersPage() {
  const [kind, setKind] = useState<PartnerKind>("contract");

  const kindTabs: TabDef<PartnerKind>[] = [
    { key: "contract", label: "Contract Brewing" },
    { key: "supplier", label: "Suppliers" },
  ];

  return (
    <main className="px-4 sm:px-6">
      <StickyHeader>
        <SubNav entries={PRODUCTION_NAV} mobile />
        <PageHeader
          title="Partners"
          description="Contract brewing partners and ingredient/packaging suppliers"
        />
        <TabBar tabs={kindTabs} activeKey={kind} onSelect={setKind} className="mb-0" />
      </StickyHeader>
      <div className="mt-6 pb-4 sm:pb-8"><PartnersTab kind={kind} setKind={setKind} /></div>
    </main>
  );
}

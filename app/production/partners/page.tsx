"use client";
import { useState } from "react";
import SubNav from "@/app/components/SubNav";
import PageHeader from "@/app/components/PageHeader";
import StickyHeader from "@/app/components/StickyHeader";
import TabBar, { type TabDef } from "@/app/components/TabBar";
import { PRODUCTION_NAV } from "@/app/production/nav-config";
import PartnersTab from "@/app/production/components/PartnersTab";
import { useContractPartnersQuery, useSuppliersQuery } from "@/app/production/hooks/queries";

export type PartnerKind = "contract" | "supplier";

export default function PartnersPage() {
  const [kind, setKind] = useState<PartnerKind>("contract");
  const { data: contractPartners = [] } = useContractPartnersQuery();
  const { data: suppliers = [] } = useSuppliersQuery();

  const kindTabs: TabDef<PartnerKind>[] = [
    {
      key: "contract",
      label: (
        <>
          Contract Brewing{" "}
          <span className="ml-1.5 text-xs text-faint">({contractPartners.length})</span>
        </>
      ),
    },
    {
      key: "supplier",
      label: (
        <>
          Suppliers{" "}
          <span className="ml-1.5 text-xs text-faint">({suppliers.length})</span>
        </>
      ),
    },
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
      <div className="mt-4 pb-4 sm:pb-8"><PartnersTab kind={kind} setKind={setKind} /></div>
    </main>
  );
}

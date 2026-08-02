"use client";
import SubNav from "@/app/components/SubNav";
import PageHeader from "@/app/components/PageHeader";
import StickyHeader from "@/app/components/StickyHeader";
import { PRODUCTION_NAV } from "@/app/production/nav-config";
import ExportTab from "@/app/production/components/ExportTab";

export default function ExportPage() {
  return (
    <main className="px-4 sm:px-6">
      <StickyHeader>
        <SubNav entries={PRODUCTION_NAV} mobile />
        <PageHeader
          title="Export"
          description="Commitments and fulfillment — track what has been allocated and what has shipped."
        />
      </StickyHeader>
      <div className="mt-4 pb-4 sm:pb-8"><ExportTab /></div>
    </main>
  );
}

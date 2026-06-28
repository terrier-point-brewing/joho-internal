"use client";
import SubNav from "@/app/components/SubNav";
import PageHeader from "@/app/components/PageHeader";
import { PRODUCTION_NAV } from "@/app/production/nav-config";
import ExportTab from "@/app/production/components/ExportTab";

export default function ExportPage() {
  return (
    <main className="px-4 sm:px-6 py-4 sm:py-8">
      <SubNav entries={PRODUCTION_NAV} mobile sticky />
      <PageHeader
        title="Export"
        description="Commitments and fulfillment — track what has been allocated and what has shipped."
      />
      <ExportTab />
    </main>
  );
}

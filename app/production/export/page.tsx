"use client";
import { useState } from "react";
import SubNav from "@/app/components/SubNav";
import PageHeader from "@/app/components/PageHeader";
import StickyHeader from "@/app/components/StickyHeader";
import TabBar, { type TabDef } from "@/app/components/TabBar";
import { PRODUCTION_NAV } from "@/app/production/nav-config";
import ExportTab from "@/app/production/components/ExportTab";

export type ExportTopTab = "export_bay" | "shipments" | "export_invoices" | "adjustments";

const TOP_TABS: TabDef<ExportTopTab>[] = [
  { key: "export_bay", label: "Export Bay" },
  { key: "shipments", label: "Shipments" },
  { key: "export_invoices", label: "Export Invoices" },
  // Cold storage lives in Export, so its adjustment journal does too. Shipments
  // is the record of what left; this is the record of what was reformatted in
  // place. Both are read-only views of actions taken on the Export Bay tab.
  { key: "adjustments", label: "Adjustments" },
];

export default function ExportPage() {
  const [tab, setTab] = useState<ExportTopTab>("export_bay");
  const [highlightInvoiceId, setHighlightInvoiceId] = useState<string | undefined>();

  function navigateToInvoice(invoiceId: string) {
    setHighlightInvoiceId(invoiceId);
    setTab("export_invoices");
  }

  return (
    <main className="px-4 sm:px-6">
      <StickyHeader>
        <SubNav entries={PRODUCTION_NAV} mobile />
        <PageHeader
          title="Export"
          description="Commitments and fulfillment — track what has been allocated and what has shipped."
        />
        <TabBar tabs={TOP_TABS} activeKey={tab} onSelect={setTab} className="mb-0" />
      </StickyHeader>
      <div className="mt-6 pb-4 sm:pb-8">
        <ExportTab tab={tab} highlightInvoiceId={highlightInvoiceId} onNavigateToInvoice={navigateToInvoice} />
      </div>
    </main>
  );
}

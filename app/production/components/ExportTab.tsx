"use client";

import { useState } from "react";
import ExportBayTab from "./ExportBayTab";
import ShipmentsTab from "./ShipmentsTab";
import ExportInvoicesTab from "./ExportInvoicesTab";
import TabBar, { type TabDef } from "@/app/components/TabBar";

type TopTab = "export_bay" | "shipments" | "export_invoices";

const TOP_TABS: TabDef<TopTab>[] = [
  { key: "export_bay", label: "Export Bay" },
  { key: "shipments", label: "Shipments" },
  { key: "export_invoices", label: "Export Invoices" },
];

export default function ExportTab() {
  const [tab, setTab] = useState<TopTab>("export_bay");
  const [highlightInvoiceId, setHighlightInvoiceId] = useState<string | undefined>();

  function navigateToInvoice(invoiceId: string) {
    setHighlightInvoiceId(invoiceId);
    setTab("export_invoices");
  }

  return (
    <>
      <TabBar tabs={TOP_TABS} activeKey={tab} onSelect={setTab} />

      {tab === "export_bay" && <ExportBayTab />}
      {tab === "shipments" && <ShipmentsTab onNavigateToInvoice={navigateToInvoice} />}
      {tab === "export_invoices" && <ExportInvoicesTab highlightInvoiceId={highlightInvoiceId} />}
    </>
  );
}

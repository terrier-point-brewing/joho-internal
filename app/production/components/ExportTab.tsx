"use client";

import { useState } from "react";
import ExportBayTab from "./ExportBayTab";
import ShipmentsTab from "./ShipmentsTab";
import ExportInvoicesTab from "./ExportInvoicesTab";

type TopTab = "export_bay" | "shipments" | "export_invoices";

const TOP_TABS: { key: TopTab; label: string }[] = [
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
      {/* Header */}
      <div className="mt-4 mb-4">
        <h2 className="text-base font-medium text-zinc-100">Export</h2>
        <p className="text-sm text-zinc-500 mt-0.5">Commitments and fulfillment — track what has been allocated and what has shipped.</p>
      </div>

      {/* Top tab bar */}
      <div className="flex gap-1 mb-6 border-b border-zinc-800 overflow-x-auto overflow-y-hidden scrollbar-none">
        {TOP_TABS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => { setTab(key); if (key !== "export_invoices") setHighlightInvoiceId(undefined); }}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === key
                ? "border-amber-500 text-zinc-100"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "export_bay" && <ExportBayTab />}
      {tab === "shipments" && <ShipmentsTab onNavigateToInvoice={navigateToInvoice} />}
      {tab === "export_invoices" && <ExportInvoicesTab highlightInvoiceId={highlightInvoiceId} />}
    </>
  );
}

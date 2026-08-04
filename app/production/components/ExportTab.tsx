"use client";

import ExportBayTab from "./ExportBayTab";
import ShipmentsTab from "./ShipmentsTab";
import ExportInvoicesTab from "./ExportInvoicesTab";
import ColdStorageAdjustmentsTab from "./ColdStorageAdjustmentsTab";
import type { ExportTopTab } from "../export/page";

export default function ExportTab({
  tab,
  highlightInvoiceId,
  onNavigateToInvoice,
}: {
  tab: ExportTopTab;
  highlightInvoiceId: string | undefined;
  onNavigateToInvoice: (invoiceId: string) => void;
}) {
  return (
    <>
      {tab === "export_bay" && <ExportBayTab />}
      {tab === "shipments" && <ShipmentsTab onNavigateToInvoice={onNavigateToInvoice} />}
      {tab === "export_invoices" && <ExportInvoicesTab highlightInvoiceId={highlightInvoiceId} />}
      {tab === "adjustments" && <ColdStorageAdjustmentsTab />}
    </>
  );
}

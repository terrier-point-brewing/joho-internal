"use client";

import PartnerLedgerTab from "./PartnerLedgerTab";
import ExportBayTab from "./ExportBayTab";
import ShipmentsTab from "./ShipmentsTab";
import ExportInvoicesTab from "./ExportInvoicesTab";
import DepositInvoicesTab from "./DepositInvoicesTab";
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
      {tab === "ledger" && <PartnerLedgerTab onNavigateToInvoice={onNavigateToInvoice} />}
      {tab === "export_bay" && <ExportBayTab />}
      {tab === "shipments" && <ShipmentsTab onNavigateToInvoice={onNavigateToInvoice} />}
      {tab === "export_invoices" && <ExportInvoicesTab highlightInvoiceId={highlightInvoiceId} />}
      {tab === "deposit_invoices" && <DepositInvoicesTab />}
      {tab === "adjustments" && <ColdStorageAdjustmentsTab />}
    </>
  );
}

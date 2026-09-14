import { redirect } from "next/navigation";

// Deposit invoices moved to Production → Export (next to Export Invoices)
// on 2026-09-13; raising one happens on Intake → Commitments.
export default function DepositInvoicesMoved() {
  redirect("/production/export");
}

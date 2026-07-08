import { redirect } from "next/navigation";
// Invoices moved under the unified Transactions tab. Keep the old path working.
export default function InvoicesRedirect() {
  redirect("/finance/transactions/invoices");
}

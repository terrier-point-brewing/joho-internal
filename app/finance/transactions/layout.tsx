import { requirePage, CAP } from "@/lib/auth";
import FinanceNav from "../FinanceNav";
import PageHeader from "@/app/components/PageHeader";
import TransactionsNav from "./TransactionsNav";
import CloseTasksBanner from "../CloseTasksBanner";

/**
 * Shared chrome for the Transactions tab. Owns the finance nav, the page
 * title, and the Orders / Invoices / Expenses sub-nav so every subtab renders
 * identical framing — each page only supplies its own control bar + body.
 */
export default async function TransactionsLayout({ children }: { children: React.ReactNode }) {
  await requirePage(CAP.financeTransactionsRead);
  return (
    <div className="flex flex-col h-full bg-canvas text-primary">
      <FinanceNav mobile />
      <div className="shrink-0 px-4 sm:px-6 pt-4 sm:pt-8">
        <PageHeader title="Transactions" description="Orders, invoices, expenses, bank lines, and manual entries — coded to the chart of accounts." />
      </div>
      <div className="shrink-0 px-4 sm:px-6">
        <TransactionsNav />
      </div>
      {/* Renders nothing unless a month-end balance is outstanding, and stays
          silent on Manual Entries where the full checklist already is. Here
          rather than on one tab because this is the surface someone reaches
          from the alert email. */}
      <CloseTasksBanner />
      {children}
    </div>
  );
}

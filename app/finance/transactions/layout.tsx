import FinanceNav from "../FinanceNav";
import PageHeader from "@/app/components/PageHeader";
import TransactionsNav from "./TransactionsNav";

/**
 * Shared chrome for the Transactions tab. Owns the finance nav, the page
 * title, and the Orders / Invoices / Expenses sub-nav so every subtab renders
 * identical framing — each page only supplies its own control bar + body.
 */
export default function TransactionsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col h-full bg-canvas text-primary">
      <FinanceNav mobile />
      <div className="shrink-0 px-4 sm:px-6">
        <PageHeader title="Transactions" />
      </div>
      <TransactionsNav />
      {children}
    </div>
  );
}

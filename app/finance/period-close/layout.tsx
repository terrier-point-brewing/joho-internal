import { requirePage, CAP } from "@/lib/auth";
import FinanceNav from "../FinanceNav";
import PageHeader from "@/app/components/PageHeader";

/**
 * Shared chrome for Period Close. Mirrors Transactions' layout (FinanceNav +
 * PageHeader owned once, up here) rather than Payroll's (each page repeats
 * its own `<main>` + nav + header) — this section has exactly two pages and
 * they should frame identically, which centralizing buys for free.
 */
export default async function PeriodCloseLayout({ children }: { children: React.ReactNode }) {
  await requirePage(CAP.financeStatementsRead);
  return (
    <div className="flex flex-col h-full bg-canvas text-primary">
      <FinanceNav mobile />
      <div className="shrink-0 px-4 sm:px-6 pt-4 sm:pt-8">
        <PageHeader
          title="Period Close"
          description="The month-end checklist and the human act of closing a period — a closed month's balances stop recomputing."
        />
      </div>
      <div className="flex-1 overflow-auto">{children}</div>
    </div>
  );
}

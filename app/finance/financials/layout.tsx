import { requirePage, CAP } from "@/lib/auth";

/**
 * The consolidated statements view (P&L, balance sheet, cash flow).
 */
export default async function FinancialsLayout({ children }: { children: React.ReactNode }) {
  await requirePage(CAP.financeStatementsRead);
  return <>{children}</>;
}

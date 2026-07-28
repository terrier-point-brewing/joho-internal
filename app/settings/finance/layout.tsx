import SubNav from "@/app/components/SubNav";
import { requirePage, CAP } from "@/lib/auth";
import { FINANCE_SETTINGS_NAV } from "../nav-config";

/**
 * Accounting configuration — the `manage` face of finance.transactions, which is
 * what these screens' own APIs have always enforced. They used to sit behind a
 * finance.statements gate that none of them referenced.
 */
export default async function FinanceSettingsLayout({ children }: { children: React.ReactNode }) {
  await requirePage(CAP.financeTransactionsManage);
  return (
    <div className="flex flex-col gap-4">
      <SubNav entries={FINANCE_SETTINGS_NAV} />
      <div>{children}</div>
    </div>
  );
}

import { requirePage, CAP } from "@/lib/auth";

/**
 * Settings screens gate on the DOMAIN they configure at `manage` — a settings
 * screen is a domain's manage face, not a place with its own permission.
 * These pages previously rode a single finance.statements gate that none of
 * their own APIs used.
 */
export default async function ChartOfAccountsLayout({ children }: { children: React.ReactNode }) {
  await requirePage(CAP.financeTransactionsManage);
  return <>{children}</>;
}

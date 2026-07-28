import { redirectToFirstReachable, CAP } from "@/lib/auth";

// One landing spot per domain represented in the settings sub-nav: whichever
// the caller can actually open. The old fixed redirect to chart-of-accounts
// bounced anyone holding payroll or tax config but not finance.transactions.
export default async function FinanceSettingsPage() {
  return redirectToFirstReachable([
    { href: "/finance/settings/chart-of-accounts", cap: CAP.financeTransactionsManage },
    { href: "/finance/settings/payroll", cap: CAP.payrollManage },
    { href: "/finance/settings/tax-profile", cap: CAP.taxManage },
    { href: "/finance/settings/tax-filing", cap: CAP.taxFilingManage },
  ]);
}

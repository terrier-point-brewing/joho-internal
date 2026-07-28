import type { Capability } from "@/lib/auth/capabilities";
import { CAP } from "@/lib/auth/capabilities";

export type NavEntry = { href: string; match?: string; label: string; also?: string; requires?: Capability };

// Each entry requires exactly what its route's layout gates on, so a visible
// tab never bounces. finance.access admits you to the section; these decide
// which of it you actually see.
export const FINANCE_NAV: NavEntry[] = [
  { href: "/finance/financials",           match: "/finance/financials",           label: "Financials",   requires: CAP.financeStatementsRead },
  { href: "/finance/transactions/orders",  match: "/finance/transactions",         label: "Transactions", requires: CAP.financeTransactionsRead },
  { href: "/finance/tax",                  match: "/finance/tax",                  label: "Tax",          requires: CAP.taxRead },
  { href: "/finance/payroll",              match: "/finance/payroll",              label: "Payroll",      requires: CAP.payrollManage },
];

export type NavEntry = { href: string; match?: string; label: string; also?: string };

export const FINANCE_NAV: NavEntry[] = [
  { href: "/finance/financials",           match: "/finance/financials",           label: "Financials"   },
  { href: "/finance/transactions/orders",  match: "/finance/transactions",         label: "Transactions" },
  { href: "/finance/tax",                  match: "/finance/tax",                  label: "Tax"          },
  { href: "/finance/payroll",              match: "/finance/payroll",              label: "Payroll"      },
  { href: "/finance/settings",             match: "/finance/settings",             label: "Settings"     },
];

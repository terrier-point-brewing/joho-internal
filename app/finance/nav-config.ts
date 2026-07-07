export type NavEntry = { href: string; match?: string; label: string; also?: string };

export const FINANCE_NAV: NavEntry[] = [
  { href: "/finance/model",                                                        label: "Model"        },
  { href: "/finance/sales/taproom",        match: "/finance/sales",                label: "Sales"        },
  { href: "/finance/statements/pl",        match: "/finance/statements",           label: "Statements"   },
  { href: "/finance/transactions/orders",  match: "/finance/transactions",         label: "Transactions" },
  { href: "/finance/payroll",              match: "/finance/payroll",              label: "Payroll"      },
  { href: "/finance/settings",             match: "/finance/settings",             label: "Settings"     },
];

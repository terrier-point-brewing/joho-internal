export type NavEntry = { href: string; match?: string; label: string; also?: string };

export const FINANCE_NAV: NavEntry[] = [
  { href: "/finance/model",                                                        label: "Model"        },
  { href: "/finance/sales/taproom",        match: "/finance/sales",                label: "Sales"        },
  { href: "/finance/statements/pl",        match: "/finance/statements",           label: "Statements"   },
  { href: "/finance/expenses",             match: "/finance/expenses",              label: "Expenses"     },
  { href: "/finance/transactions/square-transactions", match: "/finance/transactions", label: "Transactions", also: "/finance/invoices" },
  { href: "/finance/payroll",              match: "/finance/payroll",              label: "Payroll"      },
  { href: "/finance/settings",             match: "/finance/settings",             label: "Settings"     },
];

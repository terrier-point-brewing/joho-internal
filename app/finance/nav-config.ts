export type NavEntry = { href: string; match?: string; label: string };

export const FINANCE_NAV: NavEntry[] = [
  { href: "/finance/model",                                                        label: "Model"        },
  { href: "/finance/sales/taproom",        match: "/finance/sales",                label: "Sales"        },
  { href: "/finance/invoices",                                                     label: "Invoices"     },
  { href: "/finance/transactions/square-transactions", match: "/finance/transactions", label: "Transactions" },
  { href: "/finance/statements/pl",        match: "/finance/statements",           label: "Statements"   },
  { href: "/finance/settings",             match: "/finance/settings",             label: "Settings"     },
];

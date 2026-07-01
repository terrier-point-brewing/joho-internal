"use client";
import SubNav from "@/app/components/SubNav";

const SUBTABS = [
  { href: "/finance/statements/pl",            label: "P&L"           },
  { href: "/finance/statements/balance-sheet", label: "Balance Sheet" },
  { href: "/finance/statements/cash-flow",     label: "Cash Flow"     },
  { href: "/finance/statements/expenses",      label: "Expenses"      },
];

export default function StatementsNav() {
  return <SubNav entries={SUBTABS} />;
}

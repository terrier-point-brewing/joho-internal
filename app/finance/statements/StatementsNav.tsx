"use client";
import SubNav from "@/app/components/SubNav";

const SUBTABS = [
  { href: "/finance/statements/pl",            label: "P&L"           },
  { href: "/finance/statements/balance-sheet", label: "Balance Sheet" },
  { href: "/finance/statements/cash-flow",     label: "Cash Flow"     },
];

export default function StatementsNav() {
  return <SubNav entries={SUBTABS} />;
}

"use client";
import SubNav from "@/app/components/SubNav";

const TABS = [
  { href: "/finance/transactions/orders",   label: "Orders"   },
  { href: "/finance/transactions/invoices", label: "Invoices" },
  { href: "/finance/transactions/expenses", label: "Expenses" },
];

export default function TransactionsNav() {
  return <SubNav entries={TABS} />;
}

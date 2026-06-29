"use client";
import SubNav from "@/app/components/SubNav";

const TABS = [
  { href: "/finance/transactions/square-transactions", label: "POS Transactions" },
  { href: "/finance/invoices",                         label: "Invoices"          },
];

export default function TransactionsNav() {
  return <SubNav entries={TABS} />;
}

"use client";

import SubNav from "@/app/components/SubNav";

const TABS = [
  { href: "/finance/payroll", label: "Periods", exact: true },
];

export function PayrollNav() {
  return <SubNav entries={TABS} />;
}

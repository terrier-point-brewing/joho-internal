"use client";
import SubNav from "@/app/components/SubNav";
import { FINANCE_NAV } from "./nav-config";

export default function FinanceNav({ mobile = false }: { mobile?: boolean }) {
  return <SubNav entries={FINANCE_NAV} mobile={mobile} />;
}

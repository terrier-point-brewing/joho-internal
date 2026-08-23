"use client";
import SubNav from "@/app/components/SubNav";
import { MARKETING_TABS } from "./nav-config";

/**
 * The section's subtab row. Desktop shows these in the sidebar, so pages pass
 * `mobile` — same arrangement as FinanceNav.
 */
export default function MarketingNav({ mobile = false }: { mobile?: boolean }) {
  return <SubNav entries={MARKETING_TABS} mobile={mobile} />;
}

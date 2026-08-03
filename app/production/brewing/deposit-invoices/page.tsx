"use client";
import SubNav from "@/app/components/SubNav";
import { PRODUCTION_NAV, BREWING_NAV } from "@/app/production/nav-config";
import DepositInvoicesTab from "@/app/production/components/DepositInvoicesTab";
import PageHeader from "@/app/components/PageHeader";
import StickyHeader from "@/app/components/StickyHeader";

export default function DepositInvoicesPage() {
  return (
    <main className="px-4 sm:px-6">
      <StickyHeader>
        <SubNav entries={PRODUCTION_NAV} mobile />
        <PageHeader title="Brewing" description="Deposit invoices for contract-brewing allocations" />
        <SubNav entries={BREWING_NAV} />
      </StickyHeader>
      <div className="mt-6 pb-4 sm:pb-8"><DepositInvoicesTab /></div>
    </main>
  );
}

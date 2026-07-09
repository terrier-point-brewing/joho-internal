"use client";
import SubNav from "@/app/components/SubNav";
import { PRODUCTION_NAV, BREWING_NAV } from "@/app/production/nav-config";
import DepositInvoicesTab from "@/app/production/components/DepositInvoicesTab";
import PageHeader from "@/app/components/PageHeader";

export default function DepositInvoicesPage() {
  return (
    <main className="px-4 sm:px-6 py-4 sm:py-8">
      <SubNav entries={PRODUCTION_NAV} mobile sticky />
      <PageHeader title="Brewing" description="Deposit invoices for contract-brewing allocations" />
      <SubNav entries={BREWING_NAV} sticky />
      <div className="mt-4"><DepositInvoicesTab /></div>
    </main>
  );
}

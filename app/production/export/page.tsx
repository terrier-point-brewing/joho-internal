"use client";
import SubNav from "@/app/components/SubNav";
import { PRODUCTION_NAV } from "@/app/production/nav-config";
import ExportTab from "@/app/production/components/ExportTab";

export default function ExportPage() {
  return (
    <main className="px-4 sm:px-6 py-4 sm:py-8">
      <SubNav entries={PRODUCTION_NAV} mobile sticky />
      <ExportTab />
    </main>
  );
}

"use client";
import SubNav from "@/app/components/SubNav";
import { PRODUCTION_NAV, SETTINGS_NAV } from "@/app/production/nav-config";
import DepositSettingsPanel from "@/app/production/components/DepositSettingsPanel";

export default function DepositSettingsPage() {
  return (
    <main className="px-4 sm:px-6 py-4 sm:py-8">
      <SubNav entries={PRODUCTION_NAV} mobile sticky />
      <SubNav entries={SETTINGS_NAV} sticky />
      <DepositSettingsPanel />
    </main>
  );
}

"use client";
import SubNav from "@/app/components/SubNav";
import { PRODUCTION_NAV, SETTINGS_NAV } from "@/app/production/nav-config";
import ExportSettingsPanel from "@/app/production/components/ExportSettingsPanel";

export default function ProductionExportSettingsPage() {
  return (
    <main className="px-4 sm:px-6 py-4 sm:py-8">
      <SubNav entries={PRODUCTION_NAV} mobile sticky />
      <div className="mt-4 mb-2">
        <h2 className="text-base font-medium text-zinc-100">Settings</h2>
        <p className="text-sm text-zinc-500 mt-0.5">Deposits, export configuration, and Square integrations</p>
      </div>
      <SubNav entries={SETTINGS_NAV} sticky />
      <div className="mt-4"><ExportSettingsPanel scope="full" /></div>
    </main>
  );
}

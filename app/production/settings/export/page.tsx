"use client";
import SubNav from "@/app/components/SubNav";
import { PRODUCTION_NAV, SETTINGS_NAV } from "@/app/production/nav-config";
import ExportSettingsPanel from "@/app/production/components/ExportSettingsPanel";

export default function ProductionExportSettingsPage() {
  return (
    <main className="px-4 sm:px-6 py-4 sm:py-8">
      <SubNav entries={PRODUCTION_NAV} mobile sticky />
      <SubNav entries={SETTINGS_NAV} sticky />
      <ExportSettingsPanel scope="full" />
    </main>
  );
}

"use client";
import FinanceNav from "../../FinanceNav";
import SettingsNav from "../SettingsNav";
import PageHeader from "@/app/components/PageHeader";
import ExportSettingsPanel from "@/app/production/components/ExportSettingsPanel";

export default function ExciseTaxSettingsPage() {
  return (
    <div className="flex flex-col h-full bg-canvas text-primary">
      <FinanceNav mobile />
      <div className="shrink-0 px-4 sm:px-6">
        <PageHeader title="Excise Tax" description="Barrel excise tax rates and their Square line-item mappings." />
      </div>
      <SettingsNav />
      <div className="flex-1 overflow-auto px-4 sm:px-6 py-4">
        <ExportSettingsPanel scope="excise-only" />
      </div>
    </div>
  );
}

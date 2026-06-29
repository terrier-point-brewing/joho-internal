"use client";
import FinanceNav from "../../FinanceNav";
import SettingsNav from "../SettingsNav";
import ExportSettingsPanel from "@/app/production/components/ExportSettingsPanel";

export default function ExciseTaxSettingsPage() {
  return (
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-100">
      <FinanceNav mobile />
      <div className="shrink-0 px-4 sm:px-6 pt-4 sm:pt-5 pb-3">
        <h1 className="text-base font-semibold text-zinc-100">Excise Tax</h1>
        <p className="text-xs text-zinc-500 mt-0.5">Barrel excise tax rates and their Square line-item mappings.</p>
      </div>
      <SettingsNav />
      <div className="flex-1 overflow-auto px-4 sm:px-6 py-4">
        <ExportSettingsPanel scope="excise-only" />
      </div>
    </div>
  );
}

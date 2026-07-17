import FinanceNav from "../FinanceNav";
import PageHeader from "@/app/components/PageHeader";
import SettingsNav from "./SettingsNav";

/**
 * Shared chrome for the Settings tab. Owns the finance nav, the static "Settings"
 * page title, and the Settings sub-nav so every subtab renders identical framing —
 * each page only supplies its own control bar (former per-tab description + action
 * buttons) + body. Mirrors transactions/layout.tsx. See the finance UI plan, Task 1.1.
 */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col h-full bg-canvas text-primary">
      <FinanceNav mobile />
      <div className="shrink-0 px-4 sm:px-6 pt-4 sm:pt-8">
        <PageHeader title="Settings" description="Chart of accounts, GL mappings, tax, and payroll configuration." />
      </div>
      <div className="shrink-0 px-4 sm:px-6">
        <SettingsNav />
      </div>
      {children}
    </div>
  );
}

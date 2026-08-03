import SettingsHeader from "@/app/settings/SettingsHeader";
import DepositSettingsPanel from "@/app/production/components/DepositSettingsPanel";

// Group chrome (sidebar nav + mobile group row + sub-tabs) comes from the
// settings group shell; the page owns its header and content padding.
export default function DepositSettingsPage() {
  return (
    <div className="flex-1 overflow-auto px-4 sm:px-6">
      <SettingsHeader
        title="Deposit Settings"
        description="Deposit terms and the Square item deposit invoices bill against."
      />
      <div className="pb-4 sm:pb-8 max-w-3xl">
        <DepositSettingsPanel />
      </div>
    </div>
  );
}

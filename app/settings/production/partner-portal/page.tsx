import SettingsHeader from "@/app/settings/SettingsHeader";
import PartnerPortalSettingsPanel from "./PartnerPortalSettingsPanel";

// Group chrome (sidebar nav + mobile group row + sub-tabs) comes from the
// settings group shell; the page owns its header and content padding.
export default function PartnerPortalSettingsPage() {
  return (
    <div className="flex-1 overflow-auto px-4 sm:px-6">
      <SettingsHeader
        title="Partner Portal"
        description="The rules behind what external partners are offered."
      />
      <div className="pt-4 pb-4 sm:pb-8 max-w-3xl">
        <PartnerPortalSettingsPanel />
      </div>
    </div>
  );
}

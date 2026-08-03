import SettingsHeader from "@/app/settings/SettingsHeader";
import ExportSettingsPanel from "@/app/production/components/ExportSettingsPanel";

// Group chrome (sidebar nav + mobile group row + sub-tabs) comes from the
// settings group shell; the page owns its header and content padding.
export default function ProductionExportSettingsPage() {
  return (
    <div className="flex-1 overflow-auto px-4 sm:px-6">
      <SettingsHeader
        title="Export Settings"
        description="Package formats and per-partner overrides for distribution exports."
      />
      <div className="pb-4 sm:pb-8 max-w-3xl">
        <ExportSettingsPanel />
      </div>
    </div>
  );
}

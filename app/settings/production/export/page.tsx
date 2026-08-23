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
      {/* No max-width here: the mappings grid is a partner-by-service matrix and
          grows a column per partner. The narrow sections cap themselves. */}
      <div className="pt-4 pb-4 sm:pb-8">
        <ExportSettingsPanel />
      </div>
    </div>
  );
}

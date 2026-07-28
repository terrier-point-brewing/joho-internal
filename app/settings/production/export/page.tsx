import PageHeader from "@/app/components/PageHeader";
import ExportSettingsPanel from "@/app/production/components/ExportSettingsPanel";

// Group chrome (sidebar nav + mobile group row + sub-tabs) comes from the
// settings group shell; the page owns its header and content padding.
export default function ProductionExportSettingsPage() {
  return (
    <div className="flex-1 overflow-auto px-4 sm:px-6 py-4 sm:py-6">
      <div className="max-w-3xl">
        <PageHeader
          title="Export Settings"
          description="Package formats and per-partner overrides for distribution exports."
        />
        <div className="mt-4">
          <ExportSettingsPanel />
        </div>
      </div>
    </div>
  );
}

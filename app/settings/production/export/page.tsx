import PageHeader from "@/app/components/PageHeader";
import StickyHeader from "@/app/components/StickyHeader";
import ExportSettingsPanel from "@/app/production/components/ExportSettingsPanel";

// Group chrome (sidebar nav + mobile group row + sub-tabs) comes from the
// settings group shell; the page owns its header and content padding.
export default function ProductionExportSettingsPage() {
  return (
    <div className="flex-1 overflow-auto px-4 sm:px-6">
      <div className="max-w-3xl">
        <StickyHeader>
          <PageHeader
            title="Export Settings"
            description="Package formats and per-partner overrides for distribution exports."
          />
        </StickyHeader>
        <div className="pb-4 sm:pb-8">
          <ExportSettingsPanel />
        </div>
      </div>
    </div>
  );
}

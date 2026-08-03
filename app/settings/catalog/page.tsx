import SettingsHeader from "@/app/settings/SettingsHeader";
import SquareMappingsPanel from "./SquareMappingsPanel";

// Group chrome (sidebar nav + mobile group row) comes from the settings group
// shell, so the page is its header plus the panel. No outer overflow container:
// MappingGrid owns its own scroll box for the sticky row/column headers.
export default function SquareMappingsPage() {
  return (
    <div className="px-4 sm:px-6">
      <SettingsHeader
        title="Square Item Mappings"
        description="Which Square catalog item each recipe and package format sells as."
      />
      <div className="pb-4 sm:pb-6">
        <SquareMappingsPanel />
      </div>
    </div>
  );
}

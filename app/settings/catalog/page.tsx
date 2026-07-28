import PageHeader from "@/app/components/PageHeader";
import SquareMappingsPanel from "./SquareMappingsPanel";

// Group chrome (sidebar nav + mobile group row) comes from the settings group
// shell, so the page is its header plus the panel. No outer overflow container:
// MappingGrid owns its own scroll box for the sticky row/column headers.
export default function SquareMappingsPage() {
  return (
    <div className="px-4 sm:px-6 py-4 sm:py-6">
      <PageHeader
        title="Square Item Mappings"
        description="Which Square catalog item each recipe and package format sells as."
      />
      <SquareMappingsPanel />
    </div>
  );
}

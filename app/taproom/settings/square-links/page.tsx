import SquareMappingsPanel from "@/app/production/settings/square-links/SquareMappingsPanel";

// Same Square Item Mappings grid + drawer used in Production Settings, surfaced
// under Taproom Settings so taproom managers can update mappings in place. The
// panel is nav-agnostic; the taproom nav shell comes from the settings layout.
export default function TaproomSquareLinksPage() {
  return <SquareMappingsPanel />;
}

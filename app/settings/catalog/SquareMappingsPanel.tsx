"use client";

import { useState } from "react";
import MappingGrid from "./MappingGrid";
import MappingDrawer from "./MappingDrawer";

// The Square Item Mappings grid + edit drawer, decoupled from any nav shell so it
// can be mounted under both Production Settings and Taproom Settings without
// duplicating the drawer-state wiring.
export default function SquareMappingsPanel() {
  const [drawer, setDrawer] = useState<{ recipeId: string; colKey: string } | null>(null);

  return (
    <div className="mt-4">
      <MappingGrid onCellClick={(recipeId, colKey) => setDrawer({ recipeId, colKey })} />

      {drawer && (
        <MappingDrawer
          recipeId={drawer.recipeId}
          colKey={drawer.colKey}
          onClose={() => setDrawer(null)}
        />
      )}
    </div>
  );
}

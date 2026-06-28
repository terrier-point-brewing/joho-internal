"use client";

import { useState } from "react";
import MappingGrid from "./MappingGrid";
import MappingDrawer from "./MappingDrawer";

export default function SquareMappingsPage() {
  const [drawer, setDrawer] = useState<{ recipeId: string; colKey: string } | null>(null);

  return (
    <div className="p-6">
      <div className="mb-5">
        <h1 className="text-lg font-semibold text-zinc-100">Square Mappings</h1>
        <p className="text-xs text-zinc-500 mt-1">
          Map each recipe + packaging variation to a Square catalog variation. Links apply to both Taproom intake and Export invoicing.
        </p>
      </div>

      <MappingGrid
        onCellClick={(recipeId, colKey) => setDrawer({ recipeId, colKey })}
      />

      {drawer && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-30 bg-black/40"
            onClick={() => setDrawer(null)}
          />
          <MappingDrawer
            recipeId={drawer.recipeId}
            colKey={drawer.colKey}
            onClose={() => setDrawer(null)}
          />
        </>
      )}
    </div>
  );
}

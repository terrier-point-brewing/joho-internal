"use client";

import { useState } from "react";
import SubNav from "@/app/components/SubNav";
import { PRODUCTION_NAV, SETTINGS_NAV } from "@/app/production/nav-config";
import PageHeader from "@/app/components/PageHeader";
import MappingGrid from "./MappingGrid";
import MappingDrawer from "./MappingDrawer";

export default function SquareMappingsPage() {
  const [drawer, setDrawer] = useState<{ recipeId: string; colKey: string } | null>(null);

  return (
    <main className="px-4 sm:px-6 py-4 sm:py-8">
      <SubNav entries={PRODUCTION_NAV} mobile sticky />
      <PageHeader title="Settings" description="Deposits, export configuration, and Square integrations" />
      <SubNav entries={SETTINGS_NAV} sticky />
      <div className="mt-4">
        <MappingGrid
          onCellClick={(recipeId, colKey) => setDrawer({ recipeId, colKey })}
        />

        {drawer && (
          <MappingDrawer
            recipeId={drawer.recipeId}
            colKey={drawer.colKey}
            onClose={() => setDrawer(null)}
          />
        )}
      </div>
    </main>
  );
}

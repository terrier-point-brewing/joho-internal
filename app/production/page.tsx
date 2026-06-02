"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useProductionData } from "./hooks/useProductionData";
import BatchLogTab    from "./components/BatchLogTab";
import RecipesTab     from "./components/RecipesTab";
import BrewStatusTab  from "./components/BrewStatusTab";
import WorkflowsTab   from "./components/WorkflowsTab";
import InventoryTab   from "./components/InventoryTab";
import PartnersTab    from "./components/PartnersTab";

function ProductionContent() {
  const searchParams = useSearchParams();
  const tab = searchParams.get("tab") ?? "brew-console";

  const {
    ingredients, adjustments, recipes, batches, tanks, assignments, packaging, transfers,
    loadIngredients, loadAdjustments, loadRecipes, loadBatches, loadPackaging,
    refreshBrewStatus,
  } = useProductionData();

  return (
    <main className="px-6 py-8">
      {tab === "brew-console" && (
        <BrewStatusTab tanks={tanks} assignments={assignments} batches={batches} transfers={transfers} recipes={recipes} onRefresh={refreshBrewStatus} onBatchCreated={loadBatches} />
      )}
      {tab === "brew-planner" && (
        <BatchLogTab batches={batches} recipes={recipes} transfers={transfers} onRefresh={loadBatches} />
      )}
      {tab === "recipes"   && <RecipesTab recipes={recipes} ingredients={ingredients} onRefresh={loadRecipes} />}
      {tab === "workflows" && <WorkflowsTab equipment={tanks} batches={batches} />}
      {tab === "inventory" && (
        <InventoryTab
          ingredients={ingredients} adjustments={adjustments} packaging={packaging}
          transfers={transfers} tanks={tanks} batches={batches}
          onRefreshIngredients={loadIngredients} onRefreshAdjustments={loadAdjustments}
          onRefreshPackaging={loadPackaging}
        />
      )}
      {tab === "partners"  && <PartnersTab />}

      <style>{`
        .inp {
          width: 100%;
          background: rgb(39 39 42);
          border: 1px solid rgb(63 63 70);
          border-radius: 0.375rem;
          padding: 0.375rem 0.5rem;
          font-size: 0.875rem;
          color: rgb(244 244 245);
          outline: none;
        }
        .inp:focus { border-color: rgb(161 161 170); }
        .inp option { background: rgb(39 39 42); }
      `}</style>
    </main>
  );
}

export default function ProductionPage() {
  return (
    <Suspense>
      <ProductionContent />
    </Suspense>
  );
}

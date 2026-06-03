"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useProductionData } from "./hooks/useProductionData";
import BatchLogTab    from "./components/BatchLogTab";
import RecipesTab     from "./components/RecipesTab";
import BrewStatusTab  from "./components/BrewStatusTab";
import GanttTab       from "./components/GanttTab";
import CalendarTab    from "./components/CalendarTab";
import InventoryTab   from "./components/InventoryTab";
import PartnersTab    from "./components/PartnersTab";
import ExportTab      from "./components/ExportTab";
import IntakeTab      from "./components/IntakeTab";

const BREWING_SUBTABS = [
  { key: "floorplan",  label: "Floorplan"  },
  { key: "batch-log",  label: "Batch Log"  },
  { key: "timeline",   label: "Timeline"   },
  { key: "calendar",   label: "Calendar"   },
] as const;

type BrewingSubtab = typeof BREWING_SUBTABS[number]["key"];

function ProductionContent() {
  const searchParams = useSearchParams();
  const tab = searchParams.get("tab") ?? "intake";
  const [brewingSubtab, setBrewingSubtab] = useState<BrewingSubtab>("floorplan");

  const {
    ingredients, adjustments, recipes, batches, tanks, assignments, packaging, transfers,
    loadIngredients, loadAdjustments, loadRecipes, loadBatches, loadPackaging,
    refreshBrewStatus,
  } = useProductionData();

  return (
    <main className="px-6 py-8">
      {tab === "intake" && <IntakeTab />}

      {tab === "brewing" && (
        <>
          <div className="flex gap-1 mb-6 border-b border-zinc-800 pb-0">
            {BREWING_SUBTABS.map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setBrewingSubtab(key)}
                className={`px-4 py-2 text-sm font-medium rounded-t transition-colors -mb-px border-b-2 ${
                  brewingSubtab === key
                    ? "text-amber-400 border-amber-500 bg-amber-900/10"
                    : "text-zinc-500 border-transparent hover:text-zinc-300"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {brewingSubtab === "floorplan" && (
            <BrewStatusTab tanks={tanks} assignments={assignments} batches={batches} transfers={transfers} recipes={recipes} onRefresh={refreshBrewStatus} onBatchCreated={loadBatches} />
          )}
          {brewingSubtab === "batch-log" && (
            <BatchLogTab batches={batches} recipes={recipes} transfers={transfers} onRefresh={loadBatches} />
          )}
          {brewingSubtab === "timeline" && (
            <GanttTab equipment={tanks} batches={batches} />
          )}
          {brewingSubtab === "calendar" && (
            <CalendarTab batches={batches} />
          )}
        </>
      )}

      {tab === "export"    && <ExportTab batches={batches} />}
      {tab === "recipes"   && <RecipesTab recipes={recipes} ingredients={ingredients} onRefresh={loadRecipes} />}
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

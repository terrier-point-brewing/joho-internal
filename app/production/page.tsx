"use client";

import { useEffect, useState, useCallback } from "react";
import { Ingredient, StockAdjustment, Recipe, BrewBatch, Tank, BatchTankAssignment, PackagingItem } from "./types";
import BatchLogTab    from "./components/BatchLogTab";
import IngredientsTab from "./components/IngredientsTab";
import RecipesTab     from "./components/RecipesTab";
import BrewStatusTab  from "./components/BrewStatusTab";
import WorkflowsTab   from "./components/WorkflowsTab";
import PackagingTab   from "./components/PackagingTab";

const TABS = ["Brew Status", "Batch Log", "Ingredients", "Recipes", "Workflows", "Packaging"] as const;
type Tab = typeof TABS[number];

export default function ProductionPage() {
  const [tab, setTab] = useState<Tab>("Brew Status");

  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [adjustments, setAdjustments] = useState<StockAdjustment[]>([]);
  const [recipes,     setRecipes]     = useState<Recipe[]>([]);
  const [batches,     setBatches]     = useState<BrewBatch[]>([]);
  const [tanks,       setTanks]       = useState<Tank[]>([]);
  const [assignments, setAssignments] = useState<BatchTankAssignment[]>([]);
  const [packaging,   setPackaging]   = useState<PackagingItem[]>([]);

  const loadIngredients = useCallback(async () => { const r = await fetch("/api/production/ingredients");        if (r.ok) setIngredients(await r.json()); }, []);
  const loadAdjustments = useCallback(async () => { const r = await fetch("/api/production/stock-adjustments");  if (r.ok) setAdjustments(await r.json()); }, []);
  const loadRecipes     = useCallback(async () => { const r = await fetch("/api/production/recipes");            if (r.ok) setRecipes(await r.json()); }, []);
  const loadBatches     = useCallback(async () => { const r = await fetch("/api/production/batches");            if (r.ok) setBatches(await r.json()); }, []);
  const loadTanks       = useCallback(async () => { const r = await fetch("/api/production/tanks");              if (r.ok) setTanks(await r.json()); }, []);
  const loadAssignments = useCallback(async () => { const r = await fetch("/api/production/tank-assignments");   if (r.ok) setAssignments(await r.json()); }, []);
  const loadPackaging   = useCallback(async () => { const r = await fetch("/api/production/packaging");          if (r.ok) setPackaging(await r.json()); }, []);

  const refreshBrewStatus = useCallback(async () => {
    await Promise.all([loadTanks(), loadAssignments(), loadBatches()]);
  }, [loadTanks, loadAssignments, loadBatches]);

  useEffect(() => {
    loadIngredients();
    loadAdjustments();
    loadRecipes();
    loadBatches();
    loadTanks();
    loadAssignments();
    loadPackaging();
  }, [loadIngredients, loadAdjustments, loadRecipes, loadBatches, loadTanks, loadAssignments, loadPackaging]);

  return (
    <main className="max-w-7xl mx-auto px-6 py-8">
      <div className="flex gap-1 mb-6 border-b border-zinc-800">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px whitespace-nowrap ${
              tab === t
                ? "border-amber-500 text-zinc-100"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "Brew Status" && (
        <BrewStatusTab tanks={tanks} assignments={assignments} batches={batches} onRefresh={refreshBrewStatus} />
      )}
      {tab === "Batch Log"   && <BatchLogTab batches={batches} recipes={recipes} onRefresh={loadBatches} />}
      {tab === "Ingredients" && (
        <IngredientsTab
          ingredients={ingredients}
          adjustments={adjustments}
          onRefresh={loadIngredients}
          onAdjustmentsRefresh={loadAdjustments}
        />
      )}
      {tab === "Recipes"    && <RecipesTab recipes={recipes} ingredients={ingredients} onRefresh={loadRecipes} />}
      {tab === "Workflows"  && <WorkflowsTab equipment={tanks} batches={batches} />}
      {tab === "Packaging"  && <PackagingTab packaging={packaging} onRefresh={loadPackaging} />}

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

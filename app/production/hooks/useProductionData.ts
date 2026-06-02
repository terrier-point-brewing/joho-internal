"use client";

import { useState, useCallback, useEffect } from "react";
import {
  Ingredient, StockAdjustment, Recipe, BrewBatch,
  Equipment, BatchTankAssignment, PackagingItem, BatchTransfer,
} from "../types";

export function useProductionData() {
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [adjustments, setAdjustments] = useState<StockAdjustment[]>([]);
  const [recipes,     setRecipes]     = useState<Recipe[]>([]);
  const [batches,     setBatches]     = useState<BrewBatch[]>([]);
  const [tanks,       setTanks]       = useState<Equipment[]>([]);
  const [assignments, setAssignments] = useState<BatchTankAssignment[]>([]);
  const [packaging,   setPackaging]   = useState<PackagingItem[]>([]);
  const [transfers,   setTransfers]   = useState<BatchTransfer[]>([]);

  const loadIngredients = useCallback(async () => { const r = await fetch("/api/production/ingredients");       if (r.ok) setIngredients(await r.json()); }, []);
  const loadAdjustments = useCallback(async () => { const r = await fetch("/api/production/stock-adjustments"); if (r.ok) setAdjustments(await r.json()); }, []);
  const loadRecipes     = useCallback(async () => { const r = await fetch("/api/production/recipes");           if (r.ok) setRecipes(await r.json()); }, []);
  const loadBatches     = useCallback(async () => { const r = await fetch("/api/production/batches");           if (r.ok) setBatches(await r.json()); }, []);
  const loadTanks       = useCallback(async () => { const r = await fetch("/api/production/equipment");             if (r.ok) setTanks(await r.json()); }, []);
  const loadAssignments = useCallback(async () => { const r = await fetch("/api/production/tank-assignments");  if (r.ok) setAssignments(await r.json()); }, []);
  const loadPackaging   = useCallback(async () => { const r = await fetch("/api/production/packaging");         if (r.ok) setPackaging(await r.json()); }, []);
  const loadTransfers   = useCallback(async () => { const r = await fetch("/api/production/transfers");         if (r.ok) setTransfers(await r.json()); }, []);

  const refreshBrewStatus = useCallback(async () => {
    await Promise.all([loadTanks(), loadAssignments(), loadBatches(), loadTransfers()]);
  }, [loadTanks, loadAssignments, loadBatches, loadTransfers]);

  useEffect(() => {
    loadIngredients();
    loadAdjustments();
    loadRecipes();
    loadBatches();
    loadTanks();
    loadAssignments();
    loadPackaging();
    loadTransfers();
  }, [loadIngredients, loadAdjustments, loadRecipes, loadBatches, loadTanks, loadAssignments, loadPackaging, loadTransfers]);

  return {
    ingredients, adjustments, recipes, batches, tanks, assignments, packaging, transfers,
    loadIngredients, loadAdjustments, loadRecipes, loadBatches,
    loadTanks, loadAssignments, loadPackaging, loadTransfers,
    refreshBrewStatus,
  };
}

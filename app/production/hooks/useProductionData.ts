"use client";

import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  productionKeys,
  useIngredientsQuery, useAdjustmentsQuery, useRecipesQuery, useBatchesQuery,
  useEquipmentQuery, useAssignmentsQuery, usePackagingQuery, useTransfersQuery,
} from "./queries";

/**
 * Shared production data, backed by TanStack Query.
 *
 * The return shape is intentionally unchanged from the previous hand-rolled
 * version (data arrays + `loadX` / `refreshBrewStatus` functions) so all
 * existing consumers keep working. The difference is under the hood:
 *   - reads are cached and de-duplicated across components
 *   - there are no manual fetch-on-mount effects
 *   - the `loadX` callbacks now invalidate the cache (which refetches) instead
 *     of imperatively setting local state
 */
export function useProductionData() {
  const qc = useQueryClient();

  const ingredientsQ = useIngredientsQuery();
  const adjustmentsQ = useAdjustmentsQuery();
  const recipesQ     = useRecipesQuery();
  const batchesQ     = useBatchesQuery();
  const tanksQ       = useEquipmentQuery();
  const assignmentsQ = useAssignmentsQuery();
  const packagingQ   = usePackagingQuery();
  const transfersQ   = useTransfersQuery();

  const loadIngredients = useCallback(() => qc.invalidateQueries({ queryKey: productionKeys.ingredients }), [qc]);
  const loadAdjustments = useCallback(() => qc.invalidateQueries({ queryKey: productionKeys.adjustments }), [qc]);
  const loadRecipes     = useCallback(() => qc.invalidateQueries({ queryKey: productionKeys.recipes }), [qc]);
  const loadBatches     = useCallback(() => qc.invalidateQueries({ queryKey: productionKeys.batches }), [qc]);
  const loadTanks       = useCallback(() => qc.invalidateQueries({ queryKey: productionKeys.equipment }), [qc]);
  const loadAssignments = useCallback(() => qc.invalidateQueries({ queryKey: productionKeys.assignments }), [qc]);
  const loadPackaging   = useCallback(() => qc.invalidateQueries({ queryKey: productionKeys.packaging }), [qc]);
  const loadTransfers   = useCallback(() => qc.invalidateQueries({ queryKey: productionKeys.transfers }), [qc]);

  const refreshBrewStatus = useCallback(async () => {
    await Promise.all([loadTanks(), loadAssignments(), loadBatches(), loadTransfers()]);
  }, [loadTanks, loadAssignments, loadBatches, loadTransfers]);

  return {
    ingredients: ingredientsQ.data ?? [],
    adjustments: adjustmentsQ.data ?? [],
    recipes:     recipesQ.data ?? [],
    batches:     batchesQ.data ?? [],
    tanks:       tanksQ.data ?? [],
    assignments: assignmentsQ.data ?? [],
    packaging:   packagingQ.data ?? [],
    transfers:   transfersQ.data ?? [],
    loadIngredients, loadAdjustments, loadRecipes, loadBatches,
    loadTanks, loadAssignments, loadPackaging, loadTransfers,
    refreshBrewStatus,
  };
}

"use client";

import { useQuery } from "@tanstack/react-query";
import {
  Ingredient, StockAdjustment, Recipe, BrewBatch,
  Equipment, BatchTankAssignment, PackagingItem, BatchTransfer,
  ContractBrewingPartner, Supplier,
} from "../types";

// A planned/actual occupancy row from /api/production/batch-schedule.
export interface ScheduleEntry {
  id: string;
  batch_id: string;
  equipment_id: string | null;
  stage: string;
  planned_start: string;
  planned_end: string;
  actual_start: string | null;
  actual_end: string | null;
  notes: string | null;
  brew_batches?: { id: string; beer_name: string; batch_number: string; volume_bbl: number; status: string } | null;
  equipment?: { id: string; name: string; type: string } | null;
}

// Shared fetch helper. Throws on non-2xx (surfaced via query.error) and parses
// the API's { error } body when present.
export async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      /* non-JSON error body — keep the status message */
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

// Centralized query keys so reads and invalidations can never drift apart.
export const productionKeys = {
  ingredients: ["production", "ingredients"] as const,
  adjustments: ["production", "stock-adjustments"] as const,
  recipes:     ["production", "recipes"] as const,
  batches:     ["production", "batches"] as const,
  equipment:   ["production", "equipment"] as const,
  assignments: ["production", "tank-assignments"] as const,
  packaging:   ["production", "packaging"] as const,
  transfers:   ["production", "transfers"] as const,
  batchSchedule: ["production", "batch-schedule"] as const,
  contractPartners: ["partners", "contract-brewing"] as const,
  suppliers:   ["partners", "suppliers"] as const,
};

export function useIngredientsQuery() {
  return useQuery({
    queryKey: productionKeys.ingredients,
    queryFn: () => fetchJson<Ingredient[]>("/api/production/ingredients"),
  });
}

export function useAdjustmentsQuery() {
  return useQuery({
    queryKey: productionKeys.adjustments,
    queryFn: () => fetchJson<StockAdjustment[]>("/api/production/stock-adjustments"),
  });
}

export function useRecipesQuery() {
  return useQuery({
    queryKey: productionKeys.recipes,
    queryFn: () => fetchJson<Recipe[]>("/api/production/recipes"),
  });
}

export function useBatchesQuery() {
  return useQuery({
    queryKey: productionKeys.batches,
    queryFn: () => fetchJson<BrewBatch[]>("/api/production/batches"),
  });
}

export function useEquipmentQuery() {
  return useQuery({
    queryKey: productionKeys.equipment,
    queryFn: () => fetchJson<Equipment[]>("/api/production/equipment"),
  });
}

export function useAssignmentsQuery() {
  return useQuery({
    queryKey: productionKeys.assignments,
    queryFn: () => fetchJson<BatchTankAssignment[]>("/api/production/tank-assignments"),
  });
}

export function usePackagingQuery() {
  return useQuery({
    queryKey: productionKeys.packaging,
    queryFn: () => fetchJson<PackagingItem[]>("/api/production/packaging"),
  });
}

export function useTransfersQuery() {
  return useQuery({
    queryKey: productionKeys.transfers,
    queryFn: () => fetchJson<BatchTransfer[]>("/api/production/transfers"),
  });
}

export function useBatchScheduleQuery() {
  return useQuery({
    queryKey: productionKeys.batchSchedule,
    queryFn: () => fetchJson<ScheduleEntry[]>("/api/production/batch-schedule"),
  });
}

export function useContractPartnersQuery() {
  return useQuery({
    queryKey: productionKeys.contractPartners,
    queryFn: () => fetchJson<ContractBrewingPartner[]>("/api/partners/contract-brewing"),
  });
}

export function useSuppliersQuery() {
  return useQuery({
    queryKey: productionKeys.suppliers,
    queryFn: () => fetchJson<Supplier[]>("/api/partners/suppliers"),
  });
}

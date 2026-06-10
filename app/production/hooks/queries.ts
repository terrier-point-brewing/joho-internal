"use client";

import { useQuery } from "@tanstack/react-query";
import {
  Ingredient, StockAdjustment, Recipe, BrewBatch,
  Equipment, BatchTankAssignment, PackagingItem, BatchTransfer,
  ContractBrewingPartner, Supplier,
} from "../types";
import { queryKeys } from "@/lib/query-keys";

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
  cancelled_at: string | null;
  cancellation_reason: string | null;
  notes: string | null;
  brew_batches?: { id: string; beer_name: string; batch_number: string; volume_bbl: number; status: string } | null;
  equipment?: { id: string; name: string; type: string } | null;
}

export interface ScheduleConflict {
  id: string;
  entry_a: { id: string; batch_id: string; batch_number: string | null; beer_name: string | null };
  entry_b: { id: string; batch_id: string; batch_number: string | null; beer_name: string | null };
  equipment: { id: string | null; name: string | null };
  overlap_start: string;
  overlap_end: string;
  suggested_resolution: {
    equipment_id: string;
    equipment_name: string;
    new_start: string;
    new_end: string;
  } | null;
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

// Flat-value alias kept for the components that already import productionKeys.
// New code should import queryKeys from @/lib/query-keys directly.
export const productionKeys = {
  ingredients:       queryKeys.production.ingredients(),
  adjustments:       queryKeys.production.stockAdjustments(),
  recipes:           queryKeys.production.recipes(),
  batches:           queryKeys.production.batches(),
  equipment:         queryKeys.production.equipment(),
  assignments:       queryKeys.production.tankAssignments(),
  packaging:         queryKeys.production.packaging(),
  transfers:         queryKeys.production.transfers(),
  batchSchedule:     queryKeys.production.batchSchedule(),
  scheduleConflicts: queryKeys.production.scheduleConflicts(),
  contractPartners:  queryKeys.partners.contractBrewing(),
  suppliers:         queryKeys.partners.suppliers(),
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

export function useScheduleConflictsQuery() {
  return useQuery({
    queryKey: productionKeys.scheduleConflicts,
    queryFn: () => fetchJson<ScheduleConflict[]>("/api/production/schedule-conflicts"),
    refetchInterval: 60_000,
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

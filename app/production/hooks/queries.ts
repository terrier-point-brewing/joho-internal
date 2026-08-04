"use client";

import { useQuery, type QueryClient } from "@tanstack/react-query";
import {
  Ingredient, StockAdjustment, Recipe, BrewBatch,
  Equipment, BatchTankAssignment, PackagingItem, BatchTransfer,
  ContractBrewingPartner, Supplier, ExciseTaxRate, ExportServiceMapping, SquareCatalogOptions,
  PackagingVariation, RecipePackagingVariation,
  RecipeSquareLinkRow, BatchConversion, MappingGridResponse,
} from "../types";
import { queryKeys } from "@/lib/query-keys";
// Type-only — the preview payload's shape is owned by the builder that produces it.
import type { InvoicePreviewResult } from "@/lib/production/exportInvoicePreview";

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
  volume_bbl: number | null;
  downstream_entry_id: string | null;
  planned_branch: string | null;
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
  packagingVariations:       queryKeys.production.packagingVariations(),
  recipePackagingVariations: queryKeys.production.recipePackagingVariations(),
  transfers:         queryKeys.production.transfers(),
  coldStorage:       queryKeys.production.coldStorage(),
  batchSchedule:     queryKeys.production.batchSchedule(),
  scheduleConflicts: queryKeys.production.scheduleConflicts(),
  batchConversions:  queryKeys.production.batchConversions(),
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

export function usePackagingVariationsQuery() {
  return useQuery({
    queryKey: productionKeys.packagingVariations,
    queryFn: () => fetchJson<PackagingVariation[]>("/api/production/packaging-variations"),
  });
}

export function useRecipePackagingVariationsQuery() {
  return useQuery({
    queryKey: productionKeys.recipePackagingVariations,
    queryFn: () => fetchJson<RecipePackagingVariation[]>("/api/production/recipe-packaging-variations"),
  });
}


export function useRecipeSquareLinksQuery() {
  return useQuery({
    queryKey: queryKeys.production.recipeSquareLinks(),
    queryFn: () => fetchJson<RecipeSquareLinkRow[]>("/api/production/recipe-square-links"),
  });
}

export function useSquareMappingGridQuery() {
  return useQuery({
    queryKey: queryKeys.production.squareMappingGrid(),
    queryFn: () => fetchJson<MappingGridResponse>("/api/production/recipe-square-links?grid=1"),
    // The Square catalog changes out-of-band; recompute suggestions on every visit.
    staleTime: 0,
    refetchOnMount: "always",
  });
}

/**
 * Refresh every cache that reads recipe↔Square mappings.
 *
 * The mapping grid is only one of them: the flat link list feeds screens well
 * outside Settings → Catalog (the Draft Stats "Beer on this tap" picker is
 * built from the draft links, and holds them for 5 minutes). Invalidating just
 * the grid left those screens showing a pre-mapping list until they happened to
 * remount past their staleTime — a newly mapped beer looked simply missing.
 * Call this after any write to recipe_square_links or its ignore list.
 */
export function invalidateSquareMappings(qc: QueryClient): Promise<void> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: queryKeys.production.squareMappingGrid() }),
    qc.invalidateQueries({ queryKey: queryKeys.production.recipeSquareLinks() }),
  ]).then(() => undefined);
}

export function useTransfersQuery() {
  return useQuery({
    queryKey: productionKeys.transfers,
    queryFn: () => fetchJson<BatchTransfer[]>("/api/production/transfers"),
  });
}

// One per-batch finished-goods lot held in cold storage, from
// cold_storage_inventory (the on-hand source of truth). Used by the floorplan
// cold-storage tile — raw batch_transfers can't be used because packaging
// transfers land at the kegging/canning station, not the cold-storage tank.
export interface ColdStorageLot {
  id: string;
  batch_id: string;
  variation_id: string;
  quantity_on_hand: number;
  beer_name: string | null;
  batch_number: number | null;
  variation_name: string | null;
  container_type: string | null;
}

export function useColdStorageQuery() {
  return useQuery({
    queryKey: productionKeys.coldStorage,
    queryFn: () => fetchJson<ColdStorageLot[]>("/api/production/cold-storage"),
  });
}

// One row of the cold_storage_transforms journal — an internal reformatting of
// finished goods already in cold storage. `kind` says what was physically
// cracked: a keg transform is a human breaking a 1/2 keg down into sixtels and
// LOSES volume; a pack break is applyBreakDown cracking a sealed case for a
// taproom single and always conserves.
export interface ColdStorageAdjustment {
  id: string;
  occurred_at: string;
  batch_id: string;
  recipe_id: string | null;
  kind: "keg_transform" | "pack_break";
  beer_name: string | null;
  batch_number: string | null;
  from_variation_name: string | null;
  to_variation_name: string | null;
  from_units: number;
  to_units: number;
  shrinkage_fl_oz: number;
  shrinkage_bbl: number;
  note: string | null;
  source_ref: string | null;
  created_by_email: string | null;
}

export function useColdStorageAdjustmentsQuery() {
  return useQuery({
    queryKey: queryKeys.production.coldStorageAdjustments(),
    queryFn: () => fetchJson<ColdStorageAdjustment[]>("/api/production/cold-storage/adjustments"),
  });
}

export function useBatchScheduleQuery() {
  return useQuery({
    queryKey: productionKeys.batchSchedule,
    queryFn: () => fetchJson<ScheduleEntry[]>("/api/production/batch-schedule"),
  });
}

export function useBatchConversionsQuery() {
  return useQuery({
    queryKey: productionKeys.batchConversions,
    queryFn: () => fetchJson<BatchConversion[]>("/api/production/batch-conversions"),
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

export function useExciseTaxRatesQuery(party?: string) {
  return useQuery({
    queryKey: queryKeys.production.exciseTaxRates(party),
    queryFn: () =>
      fetchJson<ExciseTaxRate[]>(
        party
          ? `/api/production/export-settings/excise-tax-rates?party=${encodeURIComponent(party)}`
          : "/api/production/export-settings/excise-tax-rates"
      ),
  });
}

export function useExportServiceMappingsQuery() {
  return useQuery({
    queryKey: queryKeys.production.exportServiceMappings(),
    queryFn: () => fetchJson<ExportServiceMapping[]>("/api/production/export-settings/service-mappings"),
  });
}

export function useExportSquareCatalogQuery() {
  return useQuery({
    queryKey: queryKeys.production.exportSquareCatalog(),
    queryFn: () => fetchJson<SquareCatalogOptions>("/api/production/export-settings/square-catalog"),
  });
}

export function useExportInvoiceDueDaysQuery() {
  return useQuery({
    queryKey: queryKeys.production.exportInvoiceDueDays(),
    queryFn: () => fetchJson<{ days: number }>("/api/production/export-settings/invoice-due-days"),
  });
}

export function useDepositInvoiceDueDaysQuery() {
  return useQuery({
    queryKey: queryKeys.production.depositInvoiceDueDays(),
    queryFn: () => fetchJson<{ days: number }>("/api/production/deposit-settings/invoice-due-days"),
  });
}

export function useInvoicePreview(transactionIds: string[], billAsChannel?: string | null) {
  return useQuery({
    queryKey: ["production", "invoice-preview", transactionIds, billAsChannel ?? null] as const,
    queryFn: () => fetchJson<InvoicePreviewResult>(`/api/production/export/invoice-preview?ids=${transactionIds.join(",")}${billAsChannel ? `&billAs=${encodeURIComponent(billAsChannel)}` : ""}`),
    enabled: transactionIds.length > 0,
  });
}

// The route returns getShortfalls' rows verbatim, so re-export its type rather
// than maintaining a second copy that silently drifts (this one was already
// missing available_to_batch).
import type { IngredientShortfall } from "@/lib/production/commitments";
export type { IngredientShortfall };

export function useIngredientShortfallsQuery(batchId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.production.ingredientShortfalls(batchId),
    queryFn: () => fetchJson<IngredientShortfall[]>(`/api/production/ingredient-shortfalls?batch_id=${batchId}`),
    enabled,
    staleTime: 60_000,
  });
}

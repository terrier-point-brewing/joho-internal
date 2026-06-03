import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { apiError } from "@/lib/utils/api";
import { coldStorageLots } from "@/app/production/lib/coldStorage";
import { buildDemandCalendar } from "@/app/production/lib/demandCalendar";
import type {
  BatchTransfer, Equipment, BrewBatch, Recipe, PackagingItem,
  DistributionAllocation, ContractBrewingRequest,
} from "@/app/production/types";
import type { SafetyStockFloor } from "@/app/production/types";

export async function GET() {
  try {
    const [
      { data: transfers },
      { data: tanks },
      { data: batches },
      { data: packagingItems },
      { data: floors },
      { data: allocs },
      { data: contracts },
      { data: recipes },
      { data: adjustments },
    ] = await Promise.all([
      supabase.from("batch_transfers").select("*"),
      supabase.from("equipment").select("*"),
      supabase.from("brew_batches")
        .select("id, beer_name, batch_number, planned_brew_date, expected_delivery_date, volume_bbl, turns, status, notes, recipe_id, created_at, recipes(beer_name, brewery, brew_time_weeks, expected_yield_bbl), batch_status_history(*), planned_allocations(*)")
        .in("status", ["planning", "brewing", "fermenting", "conditioning"]),
      supabase.from("packaging_items").select("*"),
      supabase.from("safety_stock_floors").select("*"),
      supabase.from("distribution_allocations")
        .select("*, recipes(beer_name), contract_brewing_partners(company_name), packaging_items(id, name, type, volume_fl_oz)"),
      supabase.from("contract_brewing_requests")
        .select("*, recipes(beer_name), contract_brewing_partners(company_name)")
        .eq("status", "open"),
      supabase.from("recipes")
        .select("*, recipe_ingredients(*, ingredients(*))"),
      supabase.from("brew_inventory_adjustments").select("*"),
    ]);

    const typedTransfers = (transfers ?? []) as BatchTransfer[];
    const typedTanks = (tanks ?? []) as Equipment[];
    const typedBatches = (batches ?? []) as unknown as BrewBatch[];
    const typedPkg = (packagingItems ?? []) as PackagingItem[];
    const typedFloors = (floors ?? []) as SafetyStockFloor[];
    const typedAllocs = (allocs ?? []) as (DistributionAllocation & { packaging_items?: PackagingItem | null })[];
    const typedContracts = (contracts ?? []) as ContractBrewingRequest[];
    const typedRecipes = (recipes ?? []) as Recipe[];

    const packagingById = new Map(typedPkg.map((p) => [p.id, p]));

    // Aggregate brew_inventory_adjustments by transfer_id
    const adjByTransfer = new Map<string, number>();
    for (const a of adjustments ?? []) {
      const id = a.batch_transfer_id as string;
      adjByTransfer.set(id, (adjByTransfer.get(id) ?? 0) + Number(a.quantity));
    }

    // Build a map from transfer_id → packaging_item based on kegging_detail/canning_detail.
    // We don't store the packaging_item_id on batch_transfers, so we use the lot's packaging type
    // and the default packaging item for that type as a proxy.
    // A proper schema would FK batch_transfers.packaging_item_id but that's a future enhancement.
    const packagingByBatchTransfer = new Map<string, PackagingItem>();
    const lots = coldStorageLots(typedTransfers, typedTanks, typedBatches);
    for (const lot of lots) {
      // Use the first matching default packaging item for this type as a proxy.
      const defaultItem = typedPkg.find((p) => p.type === lot.packaging && p.is_default)
        ?? typedPkg.find((p) => p.type === lot.packaging);
      if (defaultItem) packagingByBatchTransfer.set(lot.transfer.id, defaultItem);
    }

    const rows = buildDemandCalendar({
      lots,
      adjustmentsByTransfer: adjByTransfer,
      packagingById,
      packagingByBatchTransfer,
      safetyFloors: typedFloors,
      allocations: typedAllocs,
      contractRequests: typedContracts,
      activeBatches: typedBatches,
      recipes: typedRecipes,
    });

    return NextResponse.json(rows);
  } catch (err) {
    return apiError(err);
  }
}

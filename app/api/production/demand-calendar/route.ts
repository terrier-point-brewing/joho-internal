import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";
import { coldStorageLots } from "@/app/production/lib/coldStorage";
import { buildDemandCalendar } from "@/app/production/lib/demandCalendar";
import { fetchOrderSales, fetchCurrentCounts } from "@/lib/square/inventory";
import { BBL_TO_FL_OZ } from "@/lib/constants/production";
import { canOzPerUnit } from "@/lib/reports/bbl-tracker";
import type {
  BatchTransfer, Equipment, BrewBatch, Recipe, PackagingItem,
  ContractBrewingRequest,
} from "@/app/production/types";
import type { SafetyStockFloor } from "@/app/production/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createSupabaseServerClient();

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
      { data: squareLinks },
    ] = await Promise.all([
      supabase.from("batch_transfers").select("*"),
      supabase.from("equipment").select("*"),
      supabase.from("brew_batches")
        .select("id, beer_name, batch_number, planned_brew_date, expected_delivery_date, volume_bbl, turns, status, notes, recipe_id, created_at, recipes(beer_name, brewery, brew_time_weeks, expected_yield_bbl), batch_status_history(*), batch_allocations(*)")
        .in("status", ["planning", "brewing", "fermenting", "conditioning", "packaging"]),
      supabase.from("packaging_items").select("*"),
      supabase.from("safety_stock_floors").select("*"),
      supabase.from("commitments")
        .select("*, recipes(beer_name), contract_brewing_partners(company_name), packaging_items(id, name, volume_fl_oz)")
        .eq("channel", "distribution")
        .in("status", ["open"]),
      supabase.from("commitments")
        .select("*, recipes(beer_name), contract_brewing_partners(company_name)")
        .eq("channel", "contract_brewing")
        .eq("status", "open"),
      supabase.from("recipes")
        .select("*, recipe_ingredients(*, ingredients(*))"),
      supabase.from("brew_inventory_adjustments").select("*"),
      supabase.from("recipe_square_links")
        .select("id, recipe_id, packaging, variation_name, square_variation_id, packaging_items(volume_fl_oz)"),
    ]);

    const typedTransfers = (transfers ?? []) as BatchTransfer[];
    const typedTanks = (tanks ?? []) as Equipment[];
    const typedBatches = (batches ?? []) as unknown as BrewBatch[];
    const typedPkg = (packagingItems ?? []) as PackagingItem[];
    const typedFloors = (floors ?? []) as SafetyStockFloor[];
    const typedAllocs = (allocs ?? []) as ContractBrewingRequest[];
    const typedContracts = (contracts ?? []) as ContractBrewingRequest[];
    const typedRecipes = (recipes ?? []) as Recipe[];

    const packagingById = new Map(typedPkg.map((p) => [p.id, p]));

    // Aggregate brew_inventory_adjustments by transfer_id
    const adjByTransfer = new Map<string, number>();
    for (const a of adjustments ?? []) {
      const id = a.batch_transfer_id as string;
      adjByTransfer.set(id, (adjByTransfer.get(id) ?? 0) + Number(a.quantity));
    }

    // Resolve each lot's real packaging item via the variation actually
    // recorded on its transfer — no more guessing a "default" item per type.
    const variationIds = [...new Set(typedTransfers.map((t) => t.variation_id).filter((id): id is string => !!id))];
    const { data: variationRows } = await supabase
      .from("packaging_variations")
      .select("id, container_id, container:packaging_items!packaging_variations_container_id_fkey(*)")
      .in("id", variationIds.length > 0 ? variationIds : ["00000000-0000-0000-0000-000000000000"]);
    const containerByVariationId = new Map(
      (variationRows ?? []).map((v) => [v.id, v.container as unknown as PackagingItem])
    );

    const packagingByBatchTransfer = new Map<string, PackagingItem>();
    const lots = coldStorageLots(typedTransfers, typedTanks, typedBatches);
    for (const lot of lots) {
      const container = lot.transfer.variation_id ? containerByVariationId.get(lot.transfer.variation_id) : undefined;
      if (container) packagingByBatchTransfer.set(lot.transfer.id, container);
    }

    // Taproom demand: Square order sales (excl. invoices) → BBL/day per recipe.
    // Also fetch live inventory counts so we can defer cold-storage draws until
    // existing taproom stock is exhausted.
    let taproomDailyBblByRecipe: Map<string, number> | undefined;
    let taproomCurrentBblByRecipe: Map<string, number> | undefined;
    if (squareLinks && squareLinks.length > 0) {
      const variationIds = squareLinks.map((l) => l.square_variation_id as string);
      const now = new Date();
      const windowStart = new Date(now.getTime() - 28 * 86400000);
      try {
        const [salesTotals, currentCounts] = await Promise.all([
          fetchOrderSales(
            windowStart.toISOString().slice(0, 10),
            now.toISOString().slice(0, 10),
            variationIds,
          ),
          fetchCurrentCounts(variationIds),
        ]);
        taproomDailyBblByRecipe = new Map();
        taproomCurrentBblByRecipe = new Map();
        for (const link of squareLinks) {
          const recipeId = link.recipe_id as string;
          const varId = link.square_variation_id as string;
          const packaging = (link as unknown as { packaging: string }).packaging;
          const variationName = (link as unknown as { variation_name: string | null }).variation_name;
          const pkgVolFlOz = ((link.packaging_items as unknown) as { volume_fl_oz: number | null } | null)?.volume_fl_oz ?? null;
          let ozPerUnit: number | null = pkgVolFlOz;
          if (packaging === "can" && variationName) ozPerUnit = canOzPerUnit(variationName);
          else if (packaging === "draft") {
            const m = variationName?.match(/(\d+(?:\.\d+)?)oz/i);
            ozPerUnit = m ? parseFloat(m[1]) : null;
          }
          const totalSold = salesTotals.get(varId) ?? 0;
          const dailyBbl = ozPerUnit ? (totalSold / 28 * ozPerUnit) / BBL_TO_FL_OZ : 0;
          taproomDailyBblByRecipe.set(recipeId, (taproomDailyBblByRecipe.get(recipeId) ?? 0) + dailyBbl);
          const currentQty = currentCounts.get(varId) ?? 0;
          const currentBbl = ozPerUnit ? (currentQty * ozPerUnit) / BBL_TO_FL_OZ : 0;
          taproomCurrentBblByRecipe.set(recipeId, (taproomCurrentBblByRecipe.get(recipeId) ?? 0) + currentBbl);
        }
      } catch {
        // Square unavailable — demand calendar still works, taproom channel shows 0.
      }
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
      taproomDailyBblByRecipe,
      taproomCurrentBblByRecipe,
    });

    return NextResponse.json(rows);
  } catch (err) {
    return apiError(err);
  }
}

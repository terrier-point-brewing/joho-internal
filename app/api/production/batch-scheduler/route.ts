import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { apiError } from "@/lib/utils/api";
import { buildDemandCalendar } from "@/app/production/lib/demandCalendar";
import { coldStorageLots } from "@/app/production/lib/coldStorage";
import { addDays, parseISO, differenceInDays } from "date-fns";
import type {
  BatchTransfer, Equipment, BrewBatch, Recipe, PackagingItem,
  DistributionAllocation, ContractBrewingRequest,
} from "@/app/production/types";
import type { SafetyStockFloor } from "@/app/production/types";

export interface EquipmentSlot {
  stage: "brewhouse" | "fermenter" | "brite";
  equipment_id: string;
  equipment_name: string;
  scheduled_start: string;
  scheduled_end: string;
}

export interface SchedulerRecommendation {
  recipe_id: string;
  style: string;
  packaging: string;
  stockout_date: string;
  demand_bbl: number;
  recommended_turns: number;
  recommended_volume_bbl: number;
  recommended_brew_date: string;
  equipment_sequence: EquipmentSlot[];
}

interface ScheduleEntry {
  equipment_id: string | null;
  planned_start: string;
  planned_end: string;
}

/** Return true if [aStart, aEnd) overlaps [bStart, bEnd). */
function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && aEnd > bStart;
}

/** Find the earliest start date ≥ earliestStart on which equipment eq is free
 *  for durationDays days, given existing schedule entries. */
function findEarliestSlot(
  eq: Equipment,
  durationDays: number,
  earliestStart: Date,
  entries: ScheduleEntry[],
  batchVolumeBbl: number,
): Date | null {
  if (eq.capacity_bbl != null && batchVolumeBbl > eq.capacity_bbl) return null;

  const busy = entries
    .filter((e) => e.equipment_id === eq.id)
    .map((e) => ({ start: parseISO(e.planned_start), end: parseISO(e.planned_end) }));

  let candidate = new Date(earliestStart);
  // Try up to 365 days out
  for (let attempt = 0; attempt < 365; attempt++) {
    const proposed_end = addDays(candidate, durationDays);
    const conflict = busy.find((b) => overlaps(candidate, proposed_end, b.start, b.end));
    if (!conflict) return candidate;
    // Jump to after the conflicting entry ends
    candidate = new Date(conflict.end);
  }
  return null;
}

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
      { data: scheduleEntries },
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
      supabase.from("recipes").select("*, recipe_ingredients(*, ingredients(*))"),
      supabase.from("brew_inventory_adjustments").select("*"),
      supabase.from("batch_schedule_entries").select("equipment_id, planned_start, planned_end"),
    ]);

    const typedTransfers = (transfers ?? []) as BatchTransfer[];
    const typedTanks = (tanks ?? []) as Equipment[];
    const typedBatches = (batches ?? []) as unknown as BrewBatch[];
    const typedPkg = (packagingItems ?? []) as PackagingItem[];
    const typedFloors = (floors ?? []) as SafetyStockFloor[];
    const typedAllocs = (allocs ?? []) as (DistributionAllocation & { packaging_items?: PackagingItem | null })[];
    const typedContracts = (contracts ?? []) as ContractBrewingRequest[];
    const typedRecipes = (recipes ?? []) as Recipe[];
    const typedEntries = (scheduleEntries ?? []) as ScheduleEntry[];

    const packagingById = new Map(typedPkg.map((p) => [p.id, p]));

    const adjByTransfer = new Map<string, number>();
    for (const a of adjustments ?? []) {
      const id = a.batch_transfer_id as string;
      adjByTransfer.set(id, (adjByTransfer.get(id) ?? 0) + Number(a.quantity));
    }

    const lots = coldStorageLots(typedTransfers, typedTanks, typedBatches);
    const packagingByBatchTransfer = new Map<string, PackagingItem>();
    for (const lot of lots) {
      const defaultItem = typedPkg.find((p) => p.type === lot.packaging && p.is_default)
        ?? typedPkg.find((p) => p.type === lot.packaging);
      if (defaultItem) packagingByBatchTransfer.set(lot.transfer.id, defaultItem);
    }

    const demandRows = buildDemandCalendar({
      lots, adjustmentsByTransfer: adjByTransfer, packagingById,
      packagingByBatchTransfer, safetyFloors: typedFloors, allocations: typedAllocs,
      contractRequests: typedContracts, activeBatches: typedBatches, recipes: typedRecipes,
    });

    const recipeById = new Map(typedRecipes.map((r) => [r.id, r]));
    const today = new Date();

    // Equipment grouped by type (only constrained types)
    const brewhouses = typedTanks.filter((t) => t.type === "brewhouse");
    const fermenters = typedTanks.filter((t) => t.type === "fermenter");
    const brites = typedTanks.filter((t) => t.type === "brite");

    const recommendations: SchedulerRecommendation[] = [];

    for (const row of demandRows) {
      if (row.status === "green") continue;
      if (!row.stockout_date) continue;

      const recipe = recipeById.get(row.recipe_id);
      if (!recipe?.expected_yield_bbl) continue;

      const daysBrewhouse = recipe.days_brewhouse ?? 1;
      const daysFermenter = recipe.days_fermenter ?? 14;
      const daysBrite = recipe.days_brite ?? 7;
      const leadTime = daysBrewhouse + daysFermenter + daysBrite;
      if (leadTime === 0) continue;

      // Demand BBL: sum of outflows over the next lead_time window
      const windowEnd = addDays(today, leadTime);
      let demandBbl = 0;
      for (const w of row.weeks) {
        const weekDate = parseISO(w.weekStart);
        if (weekDate <= windowEnd) demandBbl += w.outflow_bbl;
      }
      // Need at least enough to cover demand, capped at 4 turns
      const rawTurns = Math.ceil(demandBbl / recipe.expected_yield_bbl);
      const recommendedTurns = Math.min(Math.max(rawTurns, 1), 4);
      const recommendedVolume = recommendedTurns * recipe.expected_yield_bbl;

      // Work backwards from stockout: ideal brew date = stockout - leadTime
      const idealBrewDate = addDays(parseISO(row.stockout_date), -leadTime);
      // Don't recommend a brew date in the past
      const brewStart = idealBrewDate < today ? today : idealBrewDate;

      // Find equipment slots greedily: brewhouse → fermenter → brite
      const eqSeq: EquipmentSlot[] = [];
      let stageStart = brewStart;
      let feasible = true;

      const stages: { type: "brewhouse" | "fermenter" | "brite"; days: number; pool: Equipment[] }[] = [
        { type: "brewhouse", days: daysBrewhouse, pool: brewhouses },
        { type: "fermenter", days: daysFermenter, pool: fermenters },
        { type: "brite",     days: daysBrite,     pool: brites },
      ];

      for (const stage of stages) {
        if (stage.pool.length === 0) { feasible = false; break; }

        // Find the earliest available piece in this stage's pool
        let bestEq: Equipment | null = null;
        let bestStart: Date | null = null;

        for (const eq of stage.pool) {
          const slot = findEarliestSlot(eq, stage.days, stageStart, typedEntries, recommendedVolume);
          if (slot && (!bestStart || slot < bestStart)) {
            bestStart = slot;
            bestEq = eq;
          }
        }

        if (!bestEq || !bestStart) { feasible = false; break; }

        eqSeq.push({
          stage: stage.type,
          equipment_id: bestEq.id,
          equipment_name: bestEq.name,
          scheduled_start: bestStart.toISOString().slice(0, 10),
          scheduled_end: addDays(bestStart, stage.days).toISOString().slice(0, 10),
        });

        stageStart = addDays(bestStart, stage.days);
      }

      if (!feasible || eqSeq.length === 0) continue;

      const actualBrewDate = eqSeq[0].scheduled_start;

      recommendations.push({
        recipe_id: row.recipe_id,
        style: row.style,
        packaging: row.packaging,
        stockout_date: row.stockout_date,
        demand_bbl: Math.round(demandBbl * 100) / 100,
        recommended_turns: recommendedTurns,
        recommended_volume_bbl: Math.round(recommendedVolume * 100) / 100,
        recommended_brew_date: actualBrewDate,
        equipment_sequence: eqSeq,
      });
    }

    // Deduplicate by recipe_id — if a recipe appears as both keg and can, keep the one
    // with the earlier stockout date.
    const deduped = new Map<string, SchedulerRecommendation>();
    for (const r of recommendations) {
      const existing = deduped.get(r.recipe_id);
      if (!existing || differenceInDays(parseISO(r.stockout_date), parseISO(existing.stockout_date)) < 0) {
        deduped.set(r.recipe_id, r);
      }
    }

    return NextResponse.json([...deduped.values()]);
  } catch (err) {
    return apiError(err);
  }
}

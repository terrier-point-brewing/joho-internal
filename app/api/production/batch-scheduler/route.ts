import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";
import { buildDemandCalendar } from "@/app/production/lib/demandCalendar";
import { coldStorageLots } from "@/app/production/lib/coldStorage";
import { addDays, parseISO } from "date-fns";
import { fetchOrderSales, fetchCurrentCounts } from "@/lib/square/inventory";
import { BBL_TO_FL_OZ } from "@/lib/constants/production";
import { canOzPerUnit } from "@/lib/reports/bbl-tracker";
import type {
  BatchTransfer, Equipment, BrewBatch, Recipe, PackagingItem,
  ContractBrewingRequest,
} from "@/app/production/types";
import type { SafetyStockFloor } from "@/app/production/types";

export const dynamic = "force-dynamic";

export interface EquipmentSlot {
  stage: "brewhouse" | "fermenter" | "brite" | "kegging" | "canning";
  equipment_id: string;
  equipment_name: string;
  scheduled_start: string;
  scheduled_end: string;
  /** Kegging/canning only: daily BBL load on that date exceeds 60 BBL soft cap */
  soft_cap_warning?: boolean;
}

export interface SchedulerRecommendation {
  recipe_id: string;
  style: string;
  stockout_date: string;
  demand_bbl: number;
  recommended_turns: number;
  recommended_volume_bbl: number;
  recommended_brew_date: string;
  equipment_sequence: EquipmentSlot[];
  soft_cap_warning?: string;
}

interface ScheduleEntry {
  equipment_id: string | null;
  planned_start: string;
  planned_end: string;
  actual_start: string | null;
  actual_end: string | null;
  cancelled_at: string | null;
}

/** Return true if [aStart, aEnd) overlaps [bStart, bEnd). */
function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && aEnd > bStart;
}

/** Effective start/end: prefer actuals over planned */
function effStart(e: ScheduleEntry): Date { return parseISO(e.actual_start ?? e.planned_start); }
function effEnd(e: ScheduleEntry): Date   { return parseISO(e.actual_end   ?? e.planned_end);   }

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
    .filter((e) => e.equipment_id === eq.id && !e.cancelled_at)
    .map((e) => ({ start: effStart(e), end: effEnd(e) }));

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
      { data: scheduleEntries },
      { data: squareLinks },
      { data: activeAssignments },
    ] = await Promise.all([
      supabase.from("batch_transfers").select("*"),
      supabase.from("equipment").select("*"),
      supabase.from("brew_batches")
        .select("id, beer_name, batch_number, planned_brew_date, expected_delivery_date, volume_bbl, turns, status, notes, recipe_id, created_at, recipes(beer_name, brewery, brew_time_weeks, expected_yield_bbl), batch_status_history(*), batch_allocations(*)")
        .in("status", ["planning", "brewing", "fermenting", "conditioning", "packaging"]),
      supabase.from("packaging_items").select("*"),
      supabase.from("safety_stock_floors").select("*"),
      supabase.from("commitments")
        .select("*, recipes(beer_name), contract_brewing_partners(company_name), packaging_items(id, name, type, volume_fl_oz)")
        .eq("channel", "distribution")
        .in("status", ["open"]),
      supabase.from("commitments")
        .select("*, recipes(beer_name), contract_brewing_partners(company_name)")
        .eq("channel", "contract_brewing")
        .eq("status", "open"),
      supabase.from("recipes").select("*, recipe_ingredients(*, ingredients(*))"),
      supabase.from("brew_inventory_adjustments").select("*"),
      supabase.from("batch_schedule_entries").select("equipment_id, planned_start, planned_end, actual_start, actual_end, cancelled_at"),
      supabase.from("recipe_square_links").select("id, recipe_id, packaging, variation_name, square_variation_id, packaging_items(volume_fl_oz)"),
      supabase.from("batch_tank_assignments").select("tank_id, assigned_at").is("released_at", null),
    ]);

    const typedTransfers = (transfers ?? []) as BatchTransfer[];
    const typedTanks = (tanks ?? []) as Equipment[];
    const typedBatches = (batches ?? []) as unknown as BrewBatch[];
    const typedPkg = (packagingItems ?? []) as PackagingItem[];
    const typedFloors = (floors ?? []) as SafetyStockFloor[];
    const typedAllocs = (allocs ?? []) as ContractBrewingRequest[];
    const typedContracts = (contracts ?? []) as ContractBrewingRequest[];
    const typedRecipes = (recipes ?? []) as Recipe[];
    // Merge active tank assignments as synthetic schedule entries so tanks that
    // are physically occupied (but have no schedule entry) are treated as busy.
    const scheduledTankIds = new Set(
      (scheduleEntries ?? []).map((e) => e.equipment_id).filter(Boolean)
    );
    const syntheticEntries: ScheduleEntry[] = (activeAssignments ?? [])
      .filter((a) => !scheduledTankIds.has(a.tank_id))
      .map((a) => ({
        equipment_id: a.tank_id as string,
        planned_start: a.assigned_at as string,
        planned_end:   new Date(Date.now() + 60 * 86400000).toISOString(),
        actual_start:  a.assigned_at as string,
        actual_end:    null,
        cancelled_at:  null,
      }));
    const typedEntries = [...(scheduleEntries ?? []) as ScheduleEntry[], ...syntheticEntries];

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

    let taproomDailyBblByRecipe: Map<string, number> | undefined;
    let taproomCurrentBblByRecipe: Map<string, number> | undefined;
    if (squareLinks && squareLinks.length > 0) {
      const variationIds = (squareLinks as { square_variation_id: string }[]).map((l) => l.square_variation_id);
      const now = new Date();
      const windowStart = new Date(now.getTime() - 28 * 86400000);
      try {
        const [salesTotals, currentCounts] = await Promise.all([
          fetchOrderSales(windowStart.toISOString().slice(0, 10), now.toISOString().slice(0, 10), variationIds),
          fetchCurrentCounts(variationIds),
        ]);
        taproomDailyBblByRecipe = new Map();
        taproomCurrentBblByRecipe = new Map();
        for (const link of squareLinks as unknown as { recipe_id: string; packaging: string; variation_name: string | null; square_variation_id: string; packaging_items: { volume_fl_oz: number | null } | null }[]) {
          const pkgVolFlOz = link.packaging_items?.volume_fl_oz ?? null;
          let ozPerUnit: number | null = pkgVolFlOz;
          if (link.packaging === "can" && link.variation_name) ozPerUnit = canOzPerUnit(link.variation_name);
          else if (link.packaging === "draft") {
            const m = link.variation_name?.match(/(\d+(?:\.\d+)?)oz/i);
            ozPerUnit = m ? parseFloat(m[1]) : null;
          }
          const totalSold = salesTotals.get(link.square_variation_id) ?? 0;
          const dailyBbl = ozPerUnit ? (totalSold / 28 * ozPerUnit) / BBL_TO_FL_OZ : 0;
          taproomDailyBblByRecipe.set(link.recipe_id, (taproomDailyBblByRecipe.get(link.recipe_id) ?? 0) + dailyBbl);
          const currentQty = currentCounts.get(link.square_variation_id) ?? 0;
          const currentBbl = ozPerUnit ? (currentQty * ozPerUnit) / BBL_TO_FL_OZ : 0;
          taproomCurrentBblByRecipe.set(link.recipe_id, (taproomCurrentBblByRecipe.get(link.recipe_id) ?? 0) + currentBbl);
        }
      } catch { /* Square unavailable */ }
    }

    const demandRows = buildDemandCalendar({
      lots, adjustmentsByTransfer: adjByTransfer, packagingById,
      packagingByBatchTransfer, safetyFloors: typedFloors, allocations: typedAllocs,
      contractRequests: typedContracts, activeBatches: typedBatches, recipes: typedRecipes,
      taproomDailyBblByRecipe, taproomCurrentBblByRecipe,
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
      // Also consider total open commitments for this recipe as a floor on demand
      const commitmentBbl = [...typedAllocs, ...typedContracts]
        .filter((c) => c.recipe_id === row.recipe_id && (c.status === "open" || c.status === "in_progress"))
        .reduce((s, c) => s + Number(c.volume_bbl), 0);
      const effectiveDemand = Math.max(demandBbl, commitmentBbl);
      // Need at least enough to cover demand, capped at 4 turns
      const rawTurns = Math.ceil(effectiveDemand / recipe.expected_yield_bbl);
      const recommendedTurns = Math.min(Math.max(rawTurns, 1), 4);
      const recommendedVolume = recommendedTurns * recipe.expected_yield_bbl;

      // Work backwards from stockout: ideal brew date = stockout - leadTime
      const idealBrewDate = addDays(parseISO(row.stockout_date), -leadTime);
      // Don't recommend a brew date in the past
      const brewStart = idealBrewDate < today ? today : idealBrewDate;

      // Find equipment slots greedily: brewhouse → fermenter (same-day as brewhouse) → brite
      const eqSeq: EquipmentSlot[] = [];
      let stageStart = brewStart;
      let feasible = true;
      let brewhouseStart: Date = brewStart; // used by fermenter to anchor same-day start

      const stages: { type: "brewhouse" | "fermenter" | "brite"; days: number; pool: Equipment[] }[] = [
        { type: "brewhouse", days: daysBrewhouse, pool: brewhouses },
        { type: "fermenter", days: daysFermenter, pool: fermenters },
        { type: "brite",     days: daysBrite,     pool: brites },
      ];

      for (const stage of stages) {
        if (stage.pool.length === 0) { feasible = false; break; }

        // Fermenter begins on the same day as the brewhouse (beer moves in same day),
        // not after brewhouse completes.
        const searchFrom = stage.type === "fermenter" ? brewhouseStart : stageStart;

        // Find the earliest available piece in this stage's pool
        let bestEq: Equipment | null = null;
        let bestStart: Date | null = null;

        // Brewhouse: multiple turns run sequentially on the same day — capacity is per-turn volume.
        const effectiveVolume = stage.type === "brewhouse" ? recommendedVolume / recommendedTurns : recommendedVolume;

        for (const eq of stage.pool) {
          const slot = findEarliestSlot(eq, stage.days, searchFrom, typedEntries, effectiveVolume);
          if (slot && (!bestStart || slot < bestStart)) {
            bestStart = slot;
            bestEq = eq;
          }
        }

        if (!bestEq || !bestStart) { feasible = false; break; }

        if (stage.type === "brewhouse") brewhouseStart = bestStart;

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
        stockout_date: row.stockout_date,
        demand_bbl: Math.round(demandBbl * 100) / 100,
        recommended_turns: recommendedTurns,
        recommended_volume_bbl: Math.round(recommendedVolume * 100) / 100,
        recommended_brew_date: actualBrewDate,
        equipment_sequence: eqSeq,
      });
    }

    return NextResponse.json(recommendations);
  } catch (err) {
    return apiError(err);
  }
}

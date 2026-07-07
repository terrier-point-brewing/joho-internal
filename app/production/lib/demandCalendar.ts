/**
 * Pure demand-projection math — no React, no fetch.
 * All quantities are in BBL (1 BBL = 3968 fl oz).
 *
 * Demand is aggregated per recipe across three channels:
 *   taproom     — ongoing sell-through from Square POS (drives cold-storage → taproom exports)
 *   distribution — scheduled allocation commitments
 *   contract     — contract brewing requests
 *
 * Cold storage is the single inventory pool. All three channels draw from it.
 */
import { addWeeks, addMonths, startOfWeek, parseISO, differenceInDays, isAfter, isBefore, addDays } from "date-fns";
import { ContractBrewingRequest, BrewBatch, Recipe, PackagingItem } from "../types";
import type { SafetyStockFloor } from "../types";
import { ColdStorageLot } from "./coldStorage";
import { BBL_TO_FL_OZ } from "@/lib/constants/production";

export const FL_OZ_PER_BBL = BBL_TO_FL_OZ;
export const WEEKS_AHEAD = 12;

// ────────────────────────────────────────────────────────────
// Output types
// ────────────────────────────────────────────────────────────

export interface DemandWeek {
  weekStart: string;                    // ISO date — Monday of the week
  taproom_outflow_bbl: number;          // ongoing sell-through draw
  distribution_outflow_bbl: number;     // scheduled allocation commitments
  contract_outflow_bbl: number;         // contract request commitments
  outflow_bbl: number;                  // total outflow (sum of above)
  inflow_bbl: number;                   // active batches completing this week
  net_bbl: number;                      // inflow - outflow
  projected_eow_bbl: number;            // end-of-week running balance
}

export interface DemandRow {
  recipe_id: string;
  style: string;
  lead_time_days: number;
  current_bbl: number;
  safety_floor_bbl: number;
  taproom_bbl_per_week: number;         // for display — ongoing weekly taproom draw
  stockout_date: string | null;
  threshold_1x_date: string | null;
  threshold_15x_date: string | null;
  weeks: DemandWeek[];
  status: "green" | "yellow" | "red";
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

export function toMondayStr(d: Date): string {
  return startOfWeek(d, { weekStartsOn: 1 }).toISOString().slice(0, 10);
}

/** Convert packaged units → BBL using the packaging item's fl_oz volume. */
export function unitsToBbl(qty: number, item: PackagingItem | null | undefined): number {
  if (!item?.volume_fl_oz) return 0;
  return (qty * item.volume_fl_oz) / FL_OZ_PER_BBL;
}

/** Return ISO date string for the Monday of the week containing d. */
function weekKey(iso: string): string {
  return toMondayStr(parseISO(iso));
}

/** Expand a recurring distribution commitment into weekly BBL outflows.
 *  Returns a map of weekKey → bbl for the 12-week window. */
function expandRecurring(
  a: ContractBrewingRequest,
  windowStart: Date,
  windowEnd: Date,
): Map<string, number> {
  const result = new Map<string, number>();
  if (!a.start_date) return result;

  const bblPerOccurrence = Number(a.volume_bbl);
  if (bblPerOccurrence <= 0) return result;

  let cursor = parseISO(a.start_date);
  const end = a.end_date ? parseISO(a.end_date) : windowEnd;

  const step = a.recurrence === "weekly" ? (d: Date) => addWeeks(d, 1)
    : a.recurrence === "biweekly" ? (d: Date) => addWeeks(d, 2)
    : (d: Date) => addMonths(d, 1);

  while (!isAfter(cursor, end) && !isAfter(cursor, windowEnd)) {
    if (!isBefore(cursor, windowStart)) {
      const k = toMondayStr(cursor);
      result.set(k, (result.get(k) ?? 0) + bblPerOccurrence);
    }
    cursor = step(cursor);
  }
  return result;
}

// ────────────────────────────────────────────────────────────
// Main export
// ────────────────────────────────────────────────────────────

export interface BuildDemandCalendarInput {
  lots: ColdStorageLot[];
  packagingById: Map<string, PackagingItem>;
  packagingByBatchTransfer: Map<string, PackagingItem>;
  safetyFloors: SafetyStockFloor[];
  allocations: ContractBrewingRequest[];
  contractRequests: ContractBrewingRequest[];
  activeBatches: BrewBatch[];
  recipes: Recipe[];
  /** Taproom daily sell-through in BBL per recipe_id (from Square order sales, excl. invoices). */
  taproomDailyBblByRecipe?: Map<string, number>;
  /** Current taproom on-hand BBL per recipe_id (from Square live inventory counts). */
  taproomCurrentBblByRecipe?: Map<string, number>;
  today?: Date;
}

export function buildDemandCalendar(input: BuildDemandCalendarInput): DemandRow[] {
  const {
    lots, packagingByBatchTransfer,
    safetyFloors, allocations, contractRequests, activeBatches, recipes,
    taproomDailyBblByRecipe, taproomCurrentBblByRecipe,
  } = input;
  const today = input.today ?? new Date();

  const windowStart = startOfWeek(today, { weekStartsOn: 1 });
  const windowEnd = addWeeks(windowStart, WEEKS_AHEAD);

  const recipeById = new Map(recipes.map((r) => [r.id, r]));

  const weekStarts: string[] = [];
  for (let i = 0; i < WEEKS_AHEAD; i++) {
    weekStarts.push(toMondayStr(addWeeks(windowStart, i)));
  }

  // ── 1. Current cold-storage BBL per recipe (summed across all packaging types) ──
  const currentBblByRecipe = new Map<string, number>();
  for (const lot of lots) {
    const recipeId = lot.batch?.recipe_id;
    if (!recipeId) continue;
    const netQty = lot.initialQty;
    if (netQty <= 0) continue;
    const pkgItem = packagingByBatchTransfer.get(lot.transfer.id) ?? null;
    const bbl = unitsToBbl(netQty, pkgItem);
    if (bbl <= 0) continue;
    currentBblByRecipe.set(recipeId, (currentBblByRecipe.get(recipeId) ?? 0) + bbl);
  }

  // ── 2. Distribution outflows per recipe per week ────────────────────────────────
  const distributionOutflows = new Map<string, Map<string, number>>(); // recipe_id → weekKey → bbl
  for (const a of allocations) {
    if (!a.recipe_id) continue;
    const weekMap = distributionOutflows.get(a.recipe_id) ?? new Map<string, number>();

    if (a.cadence === "one_time" && a.desired_delivery_date) {
      const wk = weekKey(a.desired_delivery_date);
      if (weekStarts.includes(wk)) {
        weekMap.set(wk, (weekMap.get(wk) ?? 0) + Number(a.volume_bbl));
      }
    } else if (a.cadence === "recurring") {
      for (const [wk, bbl] of expandRecurring(a, windowStart, windowEnd)) {
        if (weekStarts.includes(wk)) weekMap.set(wk, (weekMap.get(wk) ?? 0) + bbl);
      }
    }
    distributionOutflows.set(a.recipe_id, weekMap);
  }

  // ── 3. Contract outflows per recipe per week ────────────────────────────────────
  const contractOutflows = new Map<string, Map<string, number>>(); // recipe_id → weekKey → bbl
  for (const req of contractRequests) {
    if (!req.recipe_id || !req.desired_delivery_date || req.status !== "open") continue;
    const weekMap = contractOutflows.get(req.recipe_id) ?? new Map<string, number>();
    const wk = weekKey(req.desired_delivery_date);
    if (weekStarts.includes(wk)) {
      weekMap.set(wk, (weekMap.get(wk) ?? 0) + Number(req.volume_bbl));
    }
    contractOutflows.set(req.recipe_id, weekMap);
  }

  // ── 4. Batch inflows per recipe per week ────────────────────────────────────────
  // Only count batches not yet in cold storage (packaged batches are already in
  // currentBblByRecipe via lots — including them here would double-count).
  // Use recipe.expected_yield_bbl × turns so shrinkage is accounted for.
  const batchesAlreadyPackaged = new Set(
    lots.map((l) => l.batch?.id).filter((id): id is string => !!id)
  );
  const batchInflows = new Map<string, Map<string, number>>(); // recipe_id → weekKey → bbl
  for (const b of activeBatches) {
    if (!b.recipe_id || !b.expected_delivery_date) continue;
    if (batchesAlreadyPackaged.has(b.id)) continue;
    const wk = weekKey(b.expected_delivery_date);
    if (!weekStarts.includes(wk)) continue;
    const recipe = recipeById.get(b.recipe_id);
    const yieldBbl = recipe?.expected_yield_bbl != null
      ? recipe.expected_yield_bbl * (b.turns ?? 1)
      : Number(b.volume_bbl);
    const wkMap = batchInflows.get(b.recipe_id) ?? new Map<string, number>();
    wkMap.set(wk, (wkMap.get(wk) ?? 0) + yieldBbl);
    batchInflows.set(b.recipe_id, wkMap);
  }

  // ── 5. Determine which recipes have any data ────────────────────────────────────
  const allRecipeIds = new Set<string>([
    ...currentBblByRecipe.keys(),
    ...distributionOutflows.keys(),
    ...contractOutflows.keys(),
    ...safetyFloors.map((f) => f.recipe_id),
    ...(taproomDailyBblByRecipe ? taproomDailyBblByRecipe.keys() : []),
  ]);

  const rows: DemandRow[] = [];

  for (const recipeId of allRecipeIds) {
    const recipe = recipeById.get(recipeId);
    if (!recipe) continue;

    const leadTime = (recipe.days_brewhouse ?? 0) + (recipe.days_fermenter ?? 0) + (recipe.days_brite ?? 0);
    const floor = safetyFloors.find((f) => f.recipe_id === recipeId);
    const floorBbl = floor ? Number(floor.floor_quantity) : 0;

    const startBbl = currentBblByRecipe.get(recipeId) ?? 0;
    const distMap = distributionOutflows.get(recipeId) ?? new Map<string, number>();
    const contMap = contractOutflows.get(recipeId) ?? new Map<string, number>();
    const inflowMap = batchInflows.get(recipeId) ?? new Map<string, number>();
    const taproomDailyBbl = taproomDailyBblByRecipe?.get(recipeId) ?? 0;
    const taproomWeeklyBbl = taproomDailyBbl * 7;

    // When taproom has existing on-hand stock, cold storage doesn't need to replenish
    // until that stock is exhausted. Calculate the date when taproom stock runs out.
    const taproomCurrentBbl = taproomCurrentBblByRecipe?.get(recipeId) ?? 0;
    const taproomExhaustionDate: Date | null =
      taproomDailyBbl > 0 && taproomCurrentBbl > 0
        ? addDays(today, taproomCurrentBbl / taproomDailyBbl)
        : null;

    let balance = startBbl;
    let stockoutDate: string | null = null;
    const weeks: DemandWeek[] = [];

    for (const wk of weekStarts) {
      // Determine how many days of this week draw from cold storage (vs. taproom on-hand).
      let taproomOut: number;
      if (!taproomExhaustionDate || taproomWeeklyBbl === 0) {
        taproomOut = taproomWeeklyBbl;
      } else {
        const weekStart = parseISO(wk);
        const weekEnd = addDays(weekStart, 7);
        // Days of this week that fall after taproom stock is exhausted
        const daysFromColdStorage = Math.max(0, Math.min(7,
          differenceInDays(weekEnd, taproomExhaustionDate)
        ));
        taproomOut = taproomDailyBbl * daysFromColdStorage;
      }

      const distOut = distMap.get(wk) ?? 0;
      const contOut = contMap.get(wk) ?? 0;
      const totalOut = taproomOut + distOut + contOut;
      const inflow = inflowMap.get(wk) ?? 0;
      balance = balance + inflow - totalOut;
      // Stockout occurs when balance drops below the safety floor (not just below zero).
      // This ensures the floor reserve is treated as untouchable committed inventory.
      if (balance < floorBbl && !stockoutDate) stockoutDate = wk;
      weeks.push({
        weekStart: wk,
        taproom_outflow_bbl: Math.round(taproomOut * 100) / 100,
        distribution_outflow_bbl: Math.round(distOut * 100) / 100,
        contract_outflow_bbl: Math.round(contOut * 100) / 100,
        outflow_bbl: Math.round(totalOut * 100) / 100,
        inflow_bbl: Math.round(inflow * 100) / 100,
        net_bbl: Math.round((inflow - totalOut) * 100) / 100,
        projected_eow_bbl: Math.round(balance * 100) / 100,
      });
    }

    let status: "green" | "yellow" | "red" = "green";
    if (stockoutDate) {
      if (leadTime === 0) {
        status = "red";
      } else {
        const daysToStockout = differenceInDays(parseISO(stockoutDate), today);
        if (daysToStockout <= leadTime) status = "red";
        else if (daysToStockout <= leadTime * 1.5) status = "yellow";
        else status = "yellow"; // any confirmed future stockout is at least a warning
      }
    }

    let threshold1x: string | null = null;
    let threshold15x: string | null = null;
    if (stockoutDate && leadTime > 0) {
      threshold1x = addDays(parseISO(stockoutDate), -leadTime).toISOString().slice(0, 10);
      threshold15x = addDays(parseISO(stockoutDate), -Math.round(leadTime * 1.5)).toISOString().slice(0, 10);
    }

    rows.push({
      recipe_id: recipeId,
      style: recipe.beer_name,
      lead_time_days: leadTime,
      current_bbl: Math.round(startBbl * 100) / 100,
      safety_floor_bbl: Math.round(floorBbl * 100) / 100,
      taproom_bbl_per_week: Math.round(taproomWeeklyBbl * 100) / 100,
      stockout_date: stockoutDate,
      threshold_1x_date: threshold1x,
      threshold_15x_date: threshold15x,
      weeks,
      status,
    });
  }

  return rows.sort((a, b) => a.style.localeCompare(b.style));
}

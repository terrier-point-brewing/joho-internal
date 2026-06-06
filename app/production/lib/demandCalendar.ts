/**
 * Pure demand-projection math — no React, no fetch.
 * All quantities are in BBL (1 BBL = 3968 fl oz).
 */
import { addWeeks, addMonths, startOfWeek, parseISO, differenceInDays, isAfter, isBefore, addDays } from "date-fns";
import { DistributionAllocation, ContractBrewingRequest, BrewBatch, Recipe, PackagingItem } from "../types";
import type { SafetyStockFloor } from "../types";
import { ColdStorageLot } from "./coldStorage";
import { BBL_TO_FL_OZ } from "@/lib/constants/production";

export const FL_OZ_PER_BBL = BBL_TO_FL_OZ;
export const WEEKS_AHEAD = 12;

// ────────────────────────────────────────────────────────────
// Output types (also consumed by API routes and UI components)
// ────────────────────────────────────────────────────────────

export interface DemandWeek {
  weekStart: string;          // ISO date — Monday of the week
  outflow_bbl: number;
  inflow_bbl: number;
  net_bbl: number;            // inflow - outflow (negative = net draw)
  projected_eow_bbl: number;  // end-of-week running balance
}

export interface DemandRow {
  recipe_id: string;
  style: string;
  packaging: "keg" | "can";
  lead_time_days: number;
  current_bbl: number;
  safety_floor_bbl: number;
  stockout_date: string | null;         // first day balance ≤ 0
  threshold_1x_date: string | null;     // today + (stockout - today - lead_time) — day we hit 1x
  threshold_15x_date: string | null;    // same for 1.5x
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

/** Expand a recurring distribution allocation into weekly BBL outflows.
 *  Returns a map of weekKey → bbl for the 12-week window. */
function expandRecurring(
  a: DistributionAllocation & { packaging_items?: PackagingItem | null },
  windowStart: Date,
  windowEnd: Date,
): Map<string, number> {
  const result = new Map<string, number>();
  if (!a.start_date) return result;

  const bblPerOccurrence = a.unit === "bbl"
    ? Number(a.quantity)
    : unitsToBbl(Number(a.quantity), a.packaging_items ?? null);

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
  /** Cold-storage lots (from coldStorageLots() helper). */
  lots: ColdStorageLot[];
  /** Net adjustments per transfer_id (sum of brew_inventory_adjustments.quantity). */
  adjustmentsByTransfer: Map<string, number>;
  /** Packaging items keyed by id (for fl_oz lookups). */
  packagingById: Map<string, PackagingItem>;
  /** Packaging items keyed by transfer_id that produced each lot.
   *  Needed to know the fl_oz volume of a kegged/canned lot. */
  packagingByBatchTransfer: Map<string, PackagingItem>;
  safetyFloors: SafetyStockFloor[];
  allocations: (DistributionAllocation & { packaging_items?: PackagingItem | null })[];
  contractRequests: ContractBrewingRequest[];
  activeBatches: BrewBatch[];
  recipes: Recipe[];
  today?: Date;
}

export function buildDemandCalendar(input: BuildDemandCalendarInput): DemandRow[] {
  const {
    lots, adjustmentsByTransfer, packagingById, packagingByBatchTransfer,
    safetyFloors, allocations, contractRequests, activeBatches, recipes,
  } = input;
  const today = input.today ?? new Date();

  const windowStart = startOfWeek(today, { weekStartsOn: 1 });
  const windowEnd = addWeeks(windowStart, WEEKS_AHEAD);

  const recipeById = new Map(recipes.map((r) => [r.id, r]));

  // Week slots: 12 Monday keys in order
  const weekStarts: string[] = [];
  for (let i = 0; i < WEEKS_AHEAD; i++) {
    weekStarts.push(toMondayStr(addWeeks(windowStart, i)));
  }

  // ── 1. Current BBL per (recipe_id, packaging) ──────────────
  type RowKey = string; // `${recipe_id}:${packaging}`
  const currentBbl = new Map<RowKey, number>();

  for (const lot of lots) {
    const recipeId = lot.batch?.recipe_id;
    if (!recipeId) continue;
    const adj = adjustmentsByTransfer.get(lot.transfer.id) ?? 0;
    const netQty = lot.initialQty + adj;
    if (netQty <= 0) continue;

    // Look up the packaging item to get fl_oz per unit.
    const pkgItem = packagingByBatchTransfer.get(lot.transfer.id) ?? null;
    const bbl = unitsToBbl(netQty, pkgItem);
    if (bbl <= 0) continue;

    const key: RowKey = `${recipeId}:${lot.packaging}`;
    currentBbl.set(key, (currentBbl.get(key) ?? 0) + bbl);
  }

  // ── 2. Outflow maps per (recipe_id, packaging) ─────────────
  // distribution_allocations: one-time and recurring
  const allocationOutflows = new Map<RowKey, Map<string, number>>();

  for (const a of allocations) {
    if (!a.recipe_id) continue;
    const key: RowKey = `${a.recipe_id}:${a.packaging}`;
    const weekMap = allocationOutflows.get(key) ?? new Map<string, number>();

    if (a.cadence === "one_time" && a.delivery_date) {
      const wk = weekKey(a.delivery_date);
      if (weekStarts.includes(wk)) {
        const bbl = a.unit === "bbl"
          ? Number(a.quantity)
          : unitsToBbl(Number(a.quantity), a.packaging_items ?? packagingById.get(a.packaging_item_id ?? "") ?? null);
        weekMap.set(wk, (weekMap.get(wk) ?? 0) + bbl);
      }
    } else if (a.cadence === "recurring") {
      for (const [wk, bbl] of expandRecurring(a, windowStart, windowEnd)) {
        if (weekStarts.includes(wk)) weekMap.set(wk, (weekMap.get(wk) ?? 0) + bbl);
      }
    }
    allocationOutflows.set(key, weekMap);
  }

  // contract_brewing_requests: volume_bbl outflow on desired_delivery_date
  // (packaging is ambiguous — attribute to "keg" as the primary BBL vehicle)
  const contractOutflows = new Map<RowKey, Map<string, number>>();
  for (const req of contractRequests) {
    if (!req.recipe_id || !req.desired_delivery_date) continue;
    if (req.status !== "open") continue;
    const key: RowKey = `${req.recipe_id}:keg`;
    const weekMap = contractOutflows.get(key) ?? new Map<string, number>();
    const wk = weekKey(req.desired_delivery_date);
    if (weekStarts.includes(wk)) {
      weekMap.set(wk, (weekMap.get(wk) ?? 0) + Number(req.volume_bbl));
    }
    contractOutflows.set(key, weekMap);
  }

  // ── 3. Inflow map per (recipe_id, packaging) ───────────────
  // active batches: volume_bbl on expected_delivery_date week
  const batchInflows = new Map<RowKey, Map<string, number>>();
  for (const b of activeBatches) {
    if (!b.recipe_id || !b.expected_delivery_date) continue;
    const wk = weekKey(b.expected_delivery_date);
    if (!weekStarts.includes(wk)) continue;
    // Attribute volume to both keg and can rows proportionally — we don't know the
    // split at batch level, so add to both packaging types that exist for this recipe.
    // In practice, most batches target one packaging type; distributing to all prevents
    // double-counting issues and gives a conservative (better) estimate.
    for (const pkg of ["keg", "can"] as const) {
      const key: RowKey = `${b.recipe_id}:${pkg}`;
      const wkMap = batchInflows.get(key) ?? new Map<string, number>();
      wkMap.set(wk, (wkMap.get(wk) ?? 0) + Number(b.volume_bbl));
      batchInflows.set(key, wkMap);
    }
  }

  // ── 4. Determine rows ──────────────────────────────────────
  // Collect all (recipe_id, packaging) keys that have any data.
  const allKeys = new Set<RowKey>([
    ...currentBbl.keys(),
    ...allocationOutflows.keys(),
    ...contractOutflows.keys(),
    ...safetyFloors.map((f) => `${f.recipe_id}:${f.packaging}`),
  ]);

  const rows: DemandRow[] = [];

  for (const key of allKeys) {
    const [recipeId, packaging] = key.split(":") as [string, "keg" | "can"];
    const recipe = recipeById.get(recipeId);
    if (!recipe) continue;

    const leadTime = (recipe.days_brewhouse ?? 0) + (recipe.days_fermenter ?? 0) + (recipe.days_brite ?? 0);
    const floor = safetyFloors.find((f) => f.recipe_id === recipeId && f.packaging === packaging);

    // Look up a representative packaging item for this recipe×packaging to get fl_oz for floor conversion.
    // Safety floor floor_quantity is in units (kegs/cans); convert to BBL.
    // We find a packaging_item via lots that belong to this recipe.
    let floorBbl = 0;
    if (floor) {
      const lotForRecipe = lots.find((l) => l.batch?.recipe_id === recipeId && l.packaging === packaging);
      const pkgItem = lotForRecipe ? packagingByBatchTransfer.get(lotForRecipe.transfer.id) : null;
      floorBbl = pkgItem ? unitsToBbl(Number(floor.floor_quantity), pkgItem) : Number(floor.floor_quantity); // fallback: treat as BBL
    }

    const startBbl = currentBbl.get(key) ?? 0;
    const aoMap = allocationOutflows.get(key) ?? new Map<string, number>();
    const coMap = contractOutflows.get(key) ?? new Map<string, number>();
    const inMap = batchInflows.get(key) ?? new Map<string, number>();

    // Build weekly projection
    let balance = startBbl;
    let stockoutDate: string | null = null;
    const weeks: DemandWeek[] = [];

    for (const wk of weekStarts) {
      const outflow = (aoMap.get(wk) ?? 0) + (coMap.get(wk) ?? 0);
      const inflow = inMap.get(wk) ?? 0;
      balance = balance + inflow - outflow;
      if (balance < 0 && !stockoutDate) {
        // Approximate stockout mid-week
        stockoutDate = wk;
      }
      weeks.push({
        weekStart: wk,
        outflow_bbl: Math.round(outflow * 100) / 100,
        inflow_bbl: Math.round(inflow * 100) / 100,
        net_bbl: Math.round((inflow - outflow) * 100) / 100,
        projected_eow_bbl: Math.round(Math.max(balance, 0) * 100) / 100,
      });
    }

    // Color status based on days until stockout vs lead time
    let status: "green" | "yellow" | "red" = "green";
    if (stockoutDate) {
      const daysToStockout = differenceInDays(parseISO(stockoutDate), today);
      if (leadTime > 0) {
        if (daysToStockout <= leadTime) status = "red";
        else if (daysToStockout <= leadTime * 1.5) status = "yellow";
      }
    }

    // Threshold dates (when we will hit 1x and 1.5x lead-time warning)
    let threshold1x: string | null = null;
    let threshold15x: string | null = null;
    if (stockoutDate && leadTime > 0) {
      threshold1x = addDays(parseISO(stockoutDate), -leadTime).toISOString().slice(0, 10);
      threshold15x = addDays(parseISO(stockoutDate), -Math.round(leadTime * 1.5)).toISOString().slice(0, 10);
    }

    rows.push({
      recipe_id: recipeId,
      style: recipe.beer_name,
      packaging,
      lead_time_days: leadTime,
      current_bbl: Math.round(startBbl * 100) / 100,
      safety_floor_bbl: Math.round(floorBbl * 100) / 100,
      stockout_date: stockoutDate,
      threshold_1x_date: threshold1x,
      threshold_15x_date: threshold15x,
      weeks,
      status,
    });
  }

  return rows.sort((a, b) => a.style.localeCompare(b.style) || a.packaging.localeCompare(b.packaging));
}

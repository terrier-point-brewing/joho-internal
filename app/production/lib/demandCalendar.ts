/**
 * Pure demand-projection math — no React, no fetch.
 * All quantities are in BBL.
 *
 * Cold storage is the single inventory pool. Four channels draw from it:
 *   taproom      — ongoing sell-through from Square
 *   distribution, wholesale, contract — the UNSHIPPED part of each open commitment
 *
 * The inputs are loaded once, by lib/production/intakeDemand.server.ts, so the
 * Demand Calendar and the Batch Scheduler can never disagree.
 */
import { addWeeks, startOfWeek, parseISO, differenceInDays, addDays } from "date-fns";
import type { Recipe, CommitmentChannel } from "../types";
import type { SafetyStockFloor } from "../types";

export const WEEKS_AHEAD = 12;
/** A stockout this many lead times away is worth a warning; further out is noise. */
export const WARN_LEAD_MULTIPLIER = 1.5;

// ────────────────────────────────────────────────────────────
// Input / output types
// ────────────────────────────────────────────────────────────

/** An open commitment, reduced to what planning needs. */
export interface CommitmentDemand {
  id: string;
  recipe_id: string;
  channel: CommitmentChannel;
  /** null = "as soon as possible": it lands in the current week. */
  desired_delivery_date: string | null;
  /** Booked minus shipped. What cold storage still has to give up. */
  unshipped_bbl: number;
  /** Booked minus what sits on a batch. What a NEW batch still has to cover. */
  unallocated_bbl: number;
  /** The unshipped volume, split by WHEN it can leave. Beer riding on a batch
   *  still in tanks cannot ship before that batch lands, so an overdue deal with
   *  a batch on the way is late — not a stockout that needs a second batch.
   *  Omitted = all of unshipped_bbl at desired_delivery_date. */
  pieces?: Array<{ bbl: number; date: string | null }>;
}

/** Beer still in tanks: expected yield minus what has already been packaged. */
export interface BatchInflow {
  recipe_id: string;
  expected_delivery_date: string;
  remaining_bbl: number;
}

export interface DemandWeek {
  weekStart: string;                    // ISO date — Monday of the week
  taproom_outflow_bbl: number;
  distribution_outflow_bbl: number;
  wholesale_outflow_bbl: number;
  contract_outflow_bbl: number;
  outflow_bbl: number;                  // total outflow (sum of above)
  inflow_bbl: number;                   // in-tank beer landing this week
  net_bbl: number;                      // inflow - outflow
  projected_eow_bbl: number;            // end-of-week running balance
}

export interface DemandRow {
  recipe_id: string;
  style: string;
  lead_time_days: number;
  current_bbl: number;
  safety_floor_bbl: number;
  taproom_bbl_per_week: number;
  stockout_date: string | null;
  threshold_1x_date: string | null;
  threshold_15x_date: string | null;
  weeks: DemandWeek[];
  status: "green" | "yellow" | "red";
}

export interface BuildDemandCalendarInput {
  /** Cold storage on hand per recipe (cold_storage_inventory — net of shipments). */
  currentBblByRecipe: Map<string, number>;
  commitments: CommitmentDemand[];
  batchInflows: BatchInflow[];
  recipes: Recipe[];
  safetyFloors?: SafetyStockFloor[];
  /** Taproom daily sell-through in BBL per recipe_id. */
  taproomDailyBblByRecipe?: Map<string, number>;
  /** Taproom on-hand BBL per recipe_id (Square live counts). */
  taproomCurrentBblByRecipe?: Map<string, number>;
  today?: Date;
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

export function toMondayStr(d: Date): string {
  return startOfWeek(d, { weekStartsOn: 1 }).toISOString().slice(0, 10);
}

const CHANNEL_KEY = {
  distribution: "distribution_outflow_bbl",
  wholesale: "wholesale_outflow_bbl",
  contract_brewing: "contract_outflow_bbl",
} as const satisfies Record<CommitmentChannel, keyof DemandWeek>;

type ChannelKey = (typeof CHANNEL_KEY)[CommitmentChannel];

const round2 = (n: number) => Math.round(n * 100) / 100;

// ────────────────────────────────────────────────────────────
// Main export
// ────────────────────────────────────────────────────────────

export function buildDemandCalendar(input: BuildDemandCalendarInput): DemandRow[] {
  const {
    currentBblByRecipe, commitments, batchInflows, recipes,
    safetyFloors = [], taproomDailyBblByRecipe, taproomCurrentBblByRecipe,
  } = input;
  const today = input.today ?? new Date();

  const windowStart = startOfWeek(today, { weekStartsOn: 1 });
  const recipeById = new Map(recipes.map((r) => [r.id, r]));

  const weekStarts: string[] = [];
  for (let i = 0; i < WEEKS_AHEAD; i++) weekStarts.push(toMondayStr(addWeeks(windowStart, i)));
  const firstWeek = weekStarts[0];
  const lastWeek = weekStarts[weekStarts.length - 1];

  /** The week a date lands in. Undated or overdue = now: the beer is still owed
   *  (or still coming), so dropping it would hide demand (or double-brew). */
  const weekFor = (iso: string | null): string | null => {
    if (!iso) return firstWeek;
    const wk = toMondayStr(parseISO(iso));
    if (wk < firstWeek) return firstWeek;
    return wk > lastWeek ? null : wk;
  };

  // ── Commitment outflows: recipe → week → channel → bbl ────────────────────
  const outflows = new Map<string, Map<string, Record<ChannelKey, number>>>();
  for (const c of commitments) {
    for (const piece of c.pieces ?? [{ bbl: c.unshipped_bbl, date: c.desired_delivery_date }]) {
      if (piece.bbl <= 0) continue;
      const wk = weekFor(piece.date);
      if (!wk) continue;
      const byWeek = outflows.get(c.recipe_id) ?? new Map<string, Record<ChannelKey, number>>();
      const cell = byWeek.get(wk) ?? { distribution_outflow_bbl: 0, wholesale_outflow_bbl: 0, contract_outflow_bbl: 0 };
      cell[CHANNEL_KEY[c.channel] ?? "contract_outflow_bbl"] += piece.bbl;
      byWeek.set(wk, cell);
      outflows.set(c.recipe_id, byWeek);
    }
  }

  // ── In-tank inflows: recipe → week → bbl ──────────────────────────────────
  const inflows = new Map<string, Map<string, number>>();
  for (const b of batchInflows) {
    if (b.remaining_bbl <= 0) continue;
    const wk = weekFor(b.expected_delivery_date);
    if (!wk) continue;
    const byWeek = inflows.get(b.recipe_id) ?? new Map<string, number>();
    byWeek.set(wk, (byWeek.get(wk) ?? 0) + b.remaining_bbl);
    inflows.set(b.recipe_id, byWeek);
  }

  const allRecipeIds = new Set<string>([
    ...currentBblByRecipe.keys(),
    ...outflows.keys(),
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
    const outMap = outflows.get(recipeId);
    const inMap = inflows.get(recipeId);
    const taproomDailyBbl = taproomDailyBblByRecipe?.get(recipeId) ?? 0;
    const taproomWeeklyBbl = taproomDailyBbl * 7;

    // The taproom draws on cold storage only once its own stock runs out.
    const taproomCurrentBbl = taproomCurrentBblByRecipe?.get(recipeId) ?? 0;
    const taproomExhaustionDate: Date | null =
      taproomDailyBbl > 0 && taproomCurrentBbl > 0
        ? addDays(today, taproomCurrentBbl / taproomDailyBbl)
        : null;

    let balance = startBbl;
    let stockoutDate: string | null = null;
    const weeks: DemandWeek[] = [];

    for (const wk of weekStarts) {
      let taproomOut = taproomWeeklyBbl;
      if (taproomExhaustionDate && taproomWeeklyBbl > 0) {
        const weekEnd = addDays(parseISO(wk), 7);
        const daysFromColdStorage = Math.max(0, Math.min(7, differenceInDays(weekEnd, taproomExhaustionDate)));
        taproomOut = taproomDailyBbl * daysFromColdStorage;
      }

      const cell = outMap?.get(wk);
      const distOut = cell?.distribution_outflow_bbl ?? 0;
      const wholesaleOut = cell?.wholesale_outflow_bbl ?? 0;
      const contOut = cell?.contract_outflow_bbl ?? 0;
      const totalOut = taproomOut + distOut + wholesaleOut + contOut;
      const inflow = inMap?.get(wk) ?? 0;
      balance = balance + inflow - totalOut;
      // Small negative drift from rounding is not a stockout.
      if (balance < floorBbl - 0.01 && !stockoutDate) stockoutDate = wk;
      weeks.push({
        weekStart: wk,
        taproom_outflow_bbl: round2(taproomOut),
        distribution_outflow_bbl: round2(distOut),
        wholesale_outflow_bbl: round2(wholesaleOut),
        contract_outflow_bbl: round2(contOut),
        outflow_bbl: round2(totalOut),
        inflow_bbl: round2(inflow),
        net_bbl: round2(inflow - totalOut),
        projected_eow_bbl: round2(balance),
      });
    }

    // Red: too late to brew in time. Yellow: brew soon. A stockout further out
    // than that needs nothing yet — flagging it made every beer a warning.
    let status: DemandRow["status"] = "green";
    if (stockoutDate) {
      const daysToStockout = differenceInDays(parseISO(stockoutDate), today);
      if (leadTime === 0 || daysToStockout <= leadTime) status = "red";
      else if (daysToStockout <= leadTime * WARN_LEAD_MULTIPLIER) status = "yellow";
    }

    let threshold1x: string | null = null;
    let threshold15x: string | null = null;
    if (stockoutDate && leadTime > 0) {
      threshold1x = addDays(parseISO(stockoutDate), -leadTime).toISOString().slice(0, 10);
      threshold15x = addDays(parseISO(stockoutDate), -Math.round(leadTime * WARN_LEAD_MULTIPLIER)).toISOString().slice(0, 10);
    }

    rows.push({
      recipe_id: recipeId,
      // The beer's name, not its style: two recipes can share a style, and two
      // identical rows cannot be told apart.
      style: recipe.beer_name ?? recipe.style,
      lead_time_days: leadTime,
      current_bbl: round2(startBbl),
      safety_floor_bbl: round2(floorBbl),
      taproom_bbl_per_week: round2(taproomWeeklyBbl),
      stockout_date: stockoutDate,
      threshold_1x_date: threshold1x,
      threshold_15x_date: threshold15x,
      weeks,
      status,
    });
  }

  return rows.sort((a, b) => a.style.localeCompare(b.style));
}

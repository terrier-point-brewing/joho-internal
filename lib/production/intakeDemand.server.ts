// lib/production/intakeDemand.server.ts
//
// The ONE loader behind Intake's planning numbers. The Demand Calendar and the
// Batch Scheduler both call it, so they cannot disagree about what is on hand,
// what is owed, or how fast the taproom sells.
//
// Every read that fails is reported in `warnings` instead of reading as zero —
// a planning screen that silently shows "all fine" is worse than one that errors.

import { BBL_TO_FL_OZ } from "@/lib/constants/production";
import { fetchColdStorageOnHand } from "@/lib/production/coldStorageOnHand";
import { fetchSellThrough } from "@/lib/square/sell-through";
import {
  buildDemandCalendar,
  type BatchInflow, type CommitmentDemand, type DemandRow,
} from "@/app/production/lib/demandCalendar";
import type { CommitmentChannel, Recipe, SafetyStockFloor } from "@/app/production/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbClient = { from: (table: string) => any };

const ACTIVE_BATCH_STATUSES = ["planning", "brewing", "fermenting", "conditioning"];

export interface IntakeDemand {
  rows: DemandRow[];
  commitments: CommitmentDemand[];
  recipes: Recipe[];
  /** Plain-language problems the planner must see (Square down, a blocked read…). */
  warnings: string[];
}

/** Booked minus shipped, and booked minus what already sits on a batch. */
export function commitmentRemainders(input: {
  bookedBbl: number;
  allocations: Array<{ percentage: number; batchVolumeBbl: number; exportedBbl: number }>;
}): { unshipped_bbl: number; unallocated_bbl: number } {
  const allocated = input.allocations.reduce((s, a) => s + (a.percentage / 100) * a.batchVolumeBbl, 0);
  const shipped = input.allocations.reduce((s, a) => s + a.exportedBbl, 0);
  return {
    unshipped_bbl: Math.max(0, input.bookedBbl - shipped),
    unallocated_bbl: Math.max(0, input.bookedBbl - allocated),
  };
}

/** Split a commitment's unshipped volume by when it can leave cold storage.
 *  The share riding on a batch still in tanks waits for that batch. */
export function commitmentPieces(input: {
  bookedBbl: number;
  desiredDate: string | null;
  /** producedBbl: what a FINISHED batch actually packaged. A batch that came in
   *  short owes its share of what it made, not of what was planned — the same
   *  rule as lib/production/allocationDelivery's owedBbl. */
  allocations: Array<{ percentage: number; batchVolumeBbl: number; exportedBbl: number; landsOn: string | null; producedBbl?: number | null }>;
}): Array<{ bbl: number; date: string | null }> {
  const pieces: Array<{ bbl: number; date: string | null }> = [];
  let left = input.bookedBbl;
  for (const a of input.allocations) {
    const share = Math.min(left, (a.percentage / 100) * a.batchVolumeBbl);
    left -= share;
    const owed = a.landsOn == null && a.producedBbl != null ? Math.min(share, (a.percentage / 100) * a.producedBbl) : share;
    const unshipped = Math.max(0, owed - a.exportedBbl);
    if (unshipped <= 0) continue;
    const date = a.landsOn && (!input.desiredDate || a.landsOn > input.desiredDate) ? a.landsOn : input.desiredDate;
    pieces.push({ bbl: unshipped, date });
  }
  if (left > 0.001) pieces.push({ bbl: left, date: input.desiredDate });
  return pieces;
}

/** Expected yield minus what is already packaged — never negative. */
export function inTankRemainingBbl(input: { expectedBbl: number; packagedBbl: number }): number {
  return Math.max(0, input.expectedBbl - input.packagedBbl);
}

export async function loadIntakeDemand(supabase: DbClient, today = new Date()): Promise<IntakeDemand> {
  const warnings: string[] = [];
  const must = <T,>(label: string, res: { data: T[] | null; error: { message: string } | null }): T[] => {
    if (res.error) throw new Error(`${label}: ${res.error.message}`);
    return res.data ?? [];
  };

  const [recipesRes, floorsRes, commitmentsRes, batchesRes] = await Promise.all([
    supabase.from("recipes").select("*"),
    supabase.from("safety_stock_floors").select("*"),
    supabase.from("commitments")
      .select("id, recipe_id, channel, volume_bbl, desired_delivery_date")
      .eq("status", "open"),
    supabase.from("brew_batches")
      .select("id, recipe_id, turns, volume_bbl, expected_delivery_date")
      .in("status", ACTIVE_BATCH_STATUSES),
  ]);
  const recipes = must<Recipe>("recipes", recipesRes);
  const floors = must<SafetyStockFloor>("safety stock", floorsRes);
  const openCommitments = must<{ id: string; recipe_id: string | null; channel: CommitmentChannel; volume_bbl: number; desired_delivery_date: string | null }>("commitments", commitmentsRes);
  const activeBatches = must<{ id: string; recipe_id: string | null; turns: number | null; volume_bbl: number | null; expected_delivery_date: string | null }>("batches", batchesRes);
  const recipeById = new Map(recipes.map((r) => [r.id, r]));

  // ── Cold storage on hand (net of shipments) ───────────────────────────────
  const currentBblByRecipe = new Map<string, number>();
  for (const [key, lot] of await fetchColdStorageOnHand(supabase)) {
    const recipeId = key.split("\t")[0];
    const bbl = (lot.qty * lot.totalVolumeFlOz) / BBL_TO_FL_OZ;
    if (bbl > 0) currentBblByRecipe.set(recipeId, (currentBblByRecipe.get(recipeId) ?? 0) + bbl);
  }

  // ── Open commitments → what is still owed / still needs a batch ───────────
  const commitmentIds = openCommitments.map((c) => c.id);
  const allocs = commitmentIds.length === 0 ? [] : must<{ id: string; contract_request_id: string; percentage: number; batch_id: string; brew_batches: { volume_bbl: number | null; status: string | null; expected_delivery_date: string | null } | null }>(
    "allocations",
    await supabase.from("batch_allocations")
      .select("id, batch_id, contract_request_id, percentage, brew_batches(volume_bbl, status, expected_delivery_date)")
      .in("contract_request_id", commitmentIds),
  );
  const allocIds = allocs.map((a) => a.id);
  const exportRows = allocIds.length === 0 ? [] : must<{ allocation_id: string; volume_bbl: number | null }>(
    "shipments",
    await supabase.from("export_transactions").select("allocation_id, volume_bbl").in("allocation_id", allocIds),
  );
  const exportedByAlloc = new Map<string, number>();
  for (const e of exportRows) exportedByAlloc.set(e.allocation_id, (exportedByAlloc.get(e.allocation_id) ?? 0) + Number(e.volume_bbl ?? 0));

  // What each batch has packaged so far (active batches + batches carrying an open deal).
  const batchIds = [...new Set([...activeBatches.map((b) => b.id), ...allocs.map((a) => a.batch_id)])];
  const packagedRows = batchIds.length === 0 ? [] : must<{ batch_id: string; volume_bbl: number | null }>(
    "packaging runs",
    await supabase.from("batch_transfers").select("batch_id, volume_bbl")
      .in("batch_id", batchIds).in("transfer_type", ["kegging", "canning"]),
  );
  const packagedByBatch = new Map<string, number>();
  for (const t of packagedRows) packagedByBatch.set(t.batch_id, (packagedByBatch.get(t.batch_id) ?? 0) + Number(t.volume_bbl ?? 0));

  const commitments: CommitmentDemand[] = [];
  for (const c of openCommitments) {
    if (!c.recipe_id) continue;
    const mine = allocs.filter((a) => a.contract_request_id === c.id).map((a) => ({
      percentage: Number(a.percentage),
      batchVolumeBbl: Number(a.brew_batches?.volume_bbl ?? 0),
      exportedBbl: exportedByAlloc.get(a.id) ?? 0,
      producedBbl: packagedByBatch.get(a.batch_id) ?? 0,
      landsOn: ACTIVE_BATCH_STATUSES.includes(a.brew_batches?.status ?? "") ? (a.brew_batches?.expected_delivery_date ?? null) : null,
    }));
    const bookedBbl = Number(c.volume_bbl ?? 0);
    commitments.push({
      id: c.id,
      recipe_id: c.recipe_id,
      channel: c.channel,
      desired_delivery_date: c.desired_delivery_date,
      ...commitmentRemainders({ bookedBbl, allocations: mine }),
      pieces: commitmentPieces({ bookedBbl, desiredDate: c.desired_delivery_date, allocations: mine }),
    });
  }

  // ── Beer still in tanks ────────────────────────────────────────────────────
  const batchInflows: BatchInflow[] = [];
  for (const b of activeBatches) {
    if (!b.recipe_id || !b.expected_delivery_date) continue;
    const yieldPerTurn = recipeById.get(b.recipe_id)?.expected_yield_bbl;
    const expectedBbl = yieldPerTurn != null ? yieldPerTurn * (b.turns ?? 1) : Number(b.volume_bbl ?? 0);
    batchInflows.push({
      recipe_id: b.recipe_id,
      expected_delivery_date: b.expected_delivery_date,
      remaining_bbl: inTankRemainingBbl({ expectedBbl, packagedBbl: packagedByBatch.get(b.id) ?? 0 }),
    });
  }

  // ── Taproom sell-through — the same function the Taproom tab uses ─────────
  let taproomDailyBblByRecipe: Map<string, number> | undefined;
  let taproomCurrentBblByRecipe: Map<string, number> | undefined;
  try {
    const links = await fetchSellThrough(supabase);
    taproomDailyBblByRecipe = new Map();
    taproomCurrentBblByRecipe = new Map();
    for (const l of links) {
      taproomDailyBblByRecipe.set(l.recipe_id, (taproomDailyBblByRecipe.get(l.recipe_id) ?? 0) + l.daily_sell_through_bbl);
      taproomCurrentBblByRecipe.set(l.recipe_id, (taproomCurrentBblByRecipe.get(l.recipe_id) ?? 0) + l.current_bbl);
    }
  } catch (err) {
    warnings.push(`Taproom sales could not be read from Square, so taproom demand shows as zero. (${err instanceof Error ? err.message : "unknown error"})`);
  }

  const rows = buildDemandCalendar({
    currentBblByRecipe, commitments, batchInflows, recipes, safetyFloors: floors,
    taproomDailyBblByRecipe, taproomCurrentBblByRecipe, today,
  });

  return { rows, commitments, recipes, warnings };
}

/**
 * What one batch of beer cost to make, and where that cost sits right now.
 *
 * ── The rule ─────────────────────────────────────────────────────────────────
 * A batch carries its raw-material cost from the day it is brewed until the
 * beer is sold. The cost is the recipe at today's ingredient prices × turns —
 * the same standard the deposit invoices bill partners on and the same one the
 * finished-goods shelf has always used, so no two screens can price the same
 * beer differently. Actual draws are NOT the basis: several batches drew for
 * one turn of a two-turn brew, and costing beer from a half-recorded draw
 * under-states it with total confidence.
 *
 * ── Shrinkage is spread over what the batch will yield ───────────────────────
 * 20 bbl of grain that packages out at 18 bbl costs 18 bbl of beer, not 20.
 * While the batch is still in tank nobody knows the final yield, so the unit
 * cost divides by the PROJECTED yield (packaged so far + in-tank volume at the
 * house packaging-yield rule — lib/production/exportIngredientDeposit). Once
 * the batch is complete the projection collapses to what was actually
 * packaged, and the beer still on the shelf re-prices to the real unit cost in
 * that month. That is the true-up: it lands in the month the batch finishes,
 * through the inventory-change row, rather than restating a closed month.
 *
 * ── Where the cost sits ──────────────────────────────────────────────────────
 *   in tank  → Work in Process (GL 1250), the in-tank share of the raw cost;
 *   packaged → Finished Goods (GL 1230), unit cost × bbl in cold storage,
 *              plus the packaging around it (lib/finance/inventoryValuation);
 *   sold     → nothing; it has left the balance sheet and the monthly change
 *              in these two accounts IS cost of goods sold.
 * A keg sent to the taproom leaves cold storage on its export row, so the
 * whole keg is costed the day it is tapped. That is a deliberate
 * simplification: the beer in open kegs at month end is a few dollars.
 *
 * ── Conversions ──────────────────────────────────────────────────────────────
 * Beer drawn off one batch into another takes its cost with it: the child
 * inherits the parent's unit cost × the bbl it received, plus whatever was
 * drawn specifically for the child (its fruit, its juice). The parent's unit
 * cost therefore divides by packaged + in-tank + converted, so the converted
 * share is neither lost nor charged twice.
 *
 * Pure arithmetic here; the loader at the bottom feeds it. Must not import
 * from lib/finance/balances — this is read by the P&L's relief rows.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { loadPackagingYieldPct, projectBatchYield } from "@/lib/production/exportIngredientDeposit";
import { computeLocationBreakdown, type LedgerTransfer } from "@/lib/production/volumeLedger";

export interface BatchCostInput {
  id: string;
  recipeId: string | null;
  turns: number | null;
  volumeBbl: number;
  status: string | null;
  convertedFromBatchId: string | null;
}

export type CostLedgerTransfer = LedgerTransfer & { transfer_type: string };

export interface BatchCost {
  /** Raw-material cost of the whole batch, cents. */
  rawCostCents: number;
  /** bbl the raw cost is spread over: packaged + expected from tank + converted away. */
  yieldBasisBbl: number;
  /** rawCostCents ÷ yieldBasisBbl; 0 when nothing has been or will be packaged. */
  costPerBblCents: number;
  /** The share of the raw cost still in tank, cents. 0 once complete. */
  wipCents: number;
  packagedBbl: number;
  inTankBbl: number;
  convertedBbl: number;
  complete: boolean;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function wholeTurns(turns: number | null | undefined): number {
  return Math.max(1, Math.floor(Number(turns) || 1));
}

/**
 * Cost every batch. Parents are costed before the children that drew off
 * them; a child whose parent is unknown falls back to its own recipe, which
 * is the complete bill and therefore the honest upper bound.
 */
export function costBatches(
  batches: BatchCostInput[],
  ledger: CostLedgerTransfer[],
  tankTypeById: Record<string, string>,
  packagingYieldPct: number,
  recipeCostPerTurnCents: ReadonlyMap<string, number>,
  ownDrawsCents: ReadonlyMap<string, number> = new Map(),
): Map<string, BatchCost> {
  const out = new Map<string, BatchCost>();
  const byId = new Map(batches.map((b) => [b.id, b]));

  // bbl each child received, from the conversion rows on its parents' ledgers.
  const inboundBbl = new Map<string, number>();
  for (const t of ledger) {
    if (t.to_batch_id && t.to_batch_id !== t.batch_id) {
      inboundBbl.set(t.to_batch_id, round4((inboundBbl.get(t.to_batch_id) ?? 0) + Number(t.volume_bbl ?? 0)));
    }
  }

  let pending = [...batches];
  while (pending.length > 0) {
    const next: BatchCostInput[] = [];
    for (const b of pending) {
      const parentId = b.convertedFromBatchId;
      const parentKnown = parentId !== null && byId.has(parentId);
      if (parentKnown && !out.has(parentId)) {
        next.push(b);
        continue;
      }

      const recipeCents = b.recipeId ? (recipeCostPerTurnCents.get(b.recipeId) ?? 0) : 0;
      let rawCostCents: number;
      if (parentKnown) {
        const parent = out.get(parentId)!;
        rawCostCents =
          Math.round(parent.costPerBblCents * (inboundBbl.get(b.id) ?? 0)) + (ownDrawsCents.get(b.id) ?? 0);
      } else {
        rawCostCents = recipeCents * wholeTurns(b.turns);
      }

      const proj = projectBatchYield(b.id, b.volumeBbl, ledger, tankTypeById, packagingYieldPct);
      const convertedBbl = round4(computeLocationBreakdown(b.id, b.volumeBbl, ledger, tankTypeById, true).converted);
      const complete = b.status === "complete";

      // Complete: nothing more is coming, so the cost spreads over what was
      // actually made. Otherwise the tank joins at its expected yield.
      const yieldBasisBbl = round4((complete ? proj.packagedBbl : proj.projectedYieldBbl) + convertedBbl);
      const costPerBblCents = yieldBasisBbl > 0 ? rawCostCents / yieldBasisBbl : 0;
      const wipCents = complete || yieldBasisBbl <= 0 ? 0 : Math.round(costPerBblCents * proj.expectedFromTankBbl);

      out.set(b.id, {
        rawCostCents,
        yieldBasisBbl,
        costPerBblCents,
        wipCents,
        packagedBbl: proj.packagedBbl,
        inTankBbl: proj.inTankBbl,
        convertedBbl,
        complete,
      });
    }
    // A conversion cycle, or a parent missing from the input: cost the rest
    // from their own recipes rather than spinning forever.
    if (next.length === pending.length) {
      for (const b of next) byId.delete(b.convertedFromBatchId!);
    }
    pending = next;
  }
  return out;
}

/** Recipe bill per turn and per bbl, at today's ingredient prices, in cents. */
export async function fetchRecipeCostCents(
  supabase: SupabaseClient,
): Promise<{ perTurn: Map<string, number>; perBbl: Map<string, number> }> {
  const rows = await fetchAllRows<{
    recipe_id: string;
    quantity_per_bbl: number | null;
    quantity_per_turn: number | null;
    ingredients: { cost_per_unit_usd: number | null } | null;
  }>(() =>
    supabase
      .from("recipe_ingredients")
      .select("recipe_id, quantity_per_bbl, quantity_per_turn, ingredients ( cost_per_unit_usd )")
      .order("id", { ascending: true }),
  );

  const perTurnDollars = new Map<string, number>();
  const perBblDollars = new Map<string, number>();
  for (const row of rows) {
    const cost = row.ingredients?.cost_per_unit_usd ?? 0;
    perTurnDollars.set(row.recipe_id, (perTurnDollars.get(row.recipe_id) ?? 0) + (row.quantity_per_turn ?? 0) * cost);
    perBblDollars.set(row.recipe_id, (perBblDollars.get(row.recipe_id) ?? 0) + (row.quantity_per_bbl ?? 0) * cost);
  }
  const toCents = (m: Map<string, number>) => new Map([...m].map(([k, v]) => [k, Math.round(v * 100)]));
  return { perTurn: toCents(perTurnDollars), perBbl: toCents(perBblDollars) };
}

/** Every batch costed from live production records. */
export async function loadBatchCosts(supabase: SupabaseClient): Promise<Map<string, BatchCost>> {
  const [batches, transfers, equipment, draws, recipeCost, packagingYieldPct] = await Promise.all([
    fetchAllRows<{
      id: string;
      recipe_id: string | null;
      turns: number | null;
      volume_bbl: number | null;
      status: string | null;
      converted_from_batch_id: string | null;
    }>(() =>
      supabase
        .from("brew_batches")
        .select("id, recipe_id, turns, volume_bbl, status, converted_from_batch_id")
        .order("id", { ascending: true }),
    ),
    fetchAllRows<CostLedgerTransfer>(() =>
      supabase
        .from("batch_transfers")
        .select("batch_id, from_tank_id, to_tank_id, to_batch_id, volume_bbl, shrinkage_bbl, transferred_at, transfer_type")
        .order("id", { ascending: true }),
    ),
    fetchAllRows<{ id: string; type: string }>(() =>
      supabase.from("equipment").select("id, type").order("id", { ascending: true }),
    ),
    // Only a conversion child's own draws matter — its fruit, its juice. A
    // brewed batch is costed from its recipe, never from its draws.
    fetchAllRows<{ batch_id: string | null; quantity: number | null; cost_per_unit_usd: number | null; total_value_change_usd: number | null }>(
      () =>
        supabase
          .from("stock_adjustments")
          .select("batch_id, quantity, cost_per_unit_usd, total_value_change_usd")
          .order("id", { ascending: true }),
    ),
    fetchRecipeCostCents(supabase),
    loadPackagingYieldPct(supabase),
  ]);

  const tankTypeById: Record<string, string> = {};
  for (const e of equipment) tankTypeById[e.id] = e.type;

  const drawsCents = new Map<string, number>();
  for (const d of draws) {
    if (!d.batch_id) continue;
    const dollars = Math.abs(d.total_value_change_usd ?? (d.quantity ?? 0) * (d.cost_per_unit_usd ?? 0));
    drawsCents.set(d.batch_id, (drawsCents.get(d.batch_id) ?? 0) + Math.round(dollars * 100));
  }

  return costBatches(
    batches.map((b) => ({
      id: b.id,
      recipeId: b.recipe_id,
      turns: b.turns,
      volumeBbl: Number(b.volume_bbl ?? 0),
      status: b.status,
      convertedFromBatchId: b.converted_from_batch_id,
    })),
    transfers,
    tankTypeById,
    packagingYieldPct,
    recipeCost.perTurn,
    drawsCents,
  );
}

/** Raw cost still in tank across every unfinished batch, cents. */
export function workInProcessCents(costs: ReadonlyMap<string, BatchCost>): number {
  let sum = 0;
  for (const c of costs.values()) sum += c.wipCents;
  return sum;
}

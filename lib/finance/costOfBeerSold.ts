/**
 * Cost of beer sold — the P&L's COGS, built from what actually left.
 *
 * ── The rule ─────────────────────────────────────────────────────────────────
 * Cost is recognised when beer leaves: every export row in the month (a
 * partner shipment, a distributor order, a taproom can sale, a keg sent to
 * the taproom) × its batch's unit cost, plus the packaging around it. A keg
 * is costed in full the day it is tapped; the beer in open kegs at month end
 * is a few dollars and is deliberately not tracked.
 *
 * Unit cost comes from lib/finance/batchCost — the recipe at today's prices
 * spread over the batch's yield — so a batch that finishes short re-prices
 * every unit it ever shipped. That is the true-up the owner asked for: when a
 * batch is exhausted and the real shrinkage is known, the months it sold in
 * are restated to the real cost, automatically.
 *
 * ── What this replaces ───────────────────────────────────────────────────────
 * Until 2026-10 the P&L carried purchases as cost and corrected them by the
 * month's change in inventory. That formula cannot tell a sale from a count
 * correction, so every backfill and opening balance landed in COGS. Now:
 *   COGS                = this module's figure, only ever a cost;
 *   purchases           = reclassified onto the balance sheet
 *                         (derivedStatementRows.injectInventoryCostRows);
 *   inventory shrinkage = the residual, on its own operating-expense account.
 *
 * ── Must not import from lib/finance/balances ────────────────────────────────
 * This feeds the frozen P&L path; see scripts/check-statement-isolation.mjs.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { BBL_TO_FL_OZ } from "@/lib/constants/production";
import { fetchRecipeCostCents, loadBatchCosts, type BatchCost } from "@/lib/finance/batchCost";
import { packagingCentsFor, type PackagingItemRow, type PackagingVariationRow } from "@/lib/finance/inventoryValuation";
import { monthEnd } from "@/lib/finance/manualEntries";

export interface CostOfBeerSoldMonth {
  /** Ingredient cost of the beer that left, cents (positive). */
  beerCents: number;
  /** Packaging consumed by the units that left, cents (positive). */
  packagingCents: number;
  /** export_transactions ids behind the figure. */
  ids: string[];
}

export type CostOfBeerSoldByMonth = Record<string, CostOfBeerSoldMonth>;

export interface SoldRow {
  id: string;
  batch_id: string | null;
  recipe_id: string | null;
  variation_id: string | null;
  volume_bbl: number | null;
  quantity: number | null;
  created_at: string;
}

/**
 * Pure: cost each sold row and bucket by month. A row whose batch cannot be
 * costed falls back to the recipe's per-bbl bill, and a row with no variation
 * carries its beer cost and no packaging — understating rather than failing,
 * the same stance the finished-goods shelf takes.
 */
export function costSoldRows(
  rows: SoldRow[],
  months: string[],
  batchCosts: ReadonlyMap<string, BatchCost>,
  recipePerBblCents: ReadonlyMap<string, number>,
  variationsById: ReadonlyMap<string, PackagingVariationRow>,
  itemsById: Map<string, PackagingItemRow>,
): CostOfBeerSoldByMonth {
  const out: CostOfBeerSoldByMonth = {};
  for (const m of months) out[m] = { beerCents: 0, packagingCents: 0, ids: [] };

  for (const r of rows) {
    const month = r.created_at.slice(0, 7);
    const bucket = out[month];
    if (!bucket) continue;

    const bbl = Number(r.volume_bbl ?? 0);
    const batch = r.batch_id ? batchCosts.get(r.batch_id) : undefined;
    const perBbl = batch && batch.costPerBblCents > 0
      ? batch.costPerBblCents
      : r.recipe_id ? (recipePerBblCents.get(r.recipe_id) ?? 0) : 0;
    bucket.beerCents += Math.round(bbl * perBbl);

    const variation = r.variation_id ? variationsById.get(r.variation_id) : undefined;
    if (variation) {
      // quantity is packages (cases, 4-packs, loose cans, kegs). When the row
      // predates the quantity column, derive packages from volume.
      const unitVolume = variation.total_volume_fl_oz ?? 0;
      const packages = r.quantity ?? (unitVolume > 0 ? Math.round((bbl * BBL_TO_FL_OZ) / unitVolume) : 0);
      bucket.packagingCents += packagingCentsFor(variation, packages, itemsById);
    }
    bucket.ids.push(r.id);
  }
  return out;
}

export async function fetchCostOfBeerSoldByMonth(
  supabase: SupabaseClient,
  months: string[],
): Promise<CostOfBeerSoldByMonth> {
  if (months.length === 0) return {};
  const first = `${months[0]}-01`;
  const last = monthEnd(`${months[months.length - 1]}-01`);

  const [rows, variations, items, recipeCost, batchCosts] = await Promise.all([
    fetchAllRows<SoldRow>(() =>
      supabase
        .from("export_transactions")
        .select("id, batch_id, recipe_id, variation_id, volume_bbl, quantity, created_at")
        .gte("created_at", first)
        .lte("created_at", `${last}T23:59:59.999Z`)
        .order("id", { ascending: true }),
    ),
    fetchAllRows<PackagingVariationRow>(() =>
      supabase
        .from("packaging_variations")
        .select("id, format, total_volume_fl_oz, container_id, lid_id, label_id, paktech_id, tray_id")
        .order("id", { ascending: true }),
    ),
    fetchAllRows<PackagingItemRow>(() =>
      supabase.from("packaging_items").select("id, type, name, unit_cost_usd, can_count").order("id", { ascending: true }),
    ),
    fetchRecipeCostCents(supabase),
    loadBatchCosts(supabase),
  ]);

  return costSoldRows(
    rows,
    months,
    batchCosts,
    recipeCost.perBbl,
    new Map(variations.map((v: PackagingVariationRow) => [v.id, v])),
    new Map(items.map((i: PackagingItemRow) => [i.id, i])),
  );
}

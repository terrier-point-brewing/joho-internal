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
 * ── Beer brewed before tracking began is already a cost ──────────────────────
 * Inventory tracking started the first month a shelf has a value. Every
 * purchase before that was expensed straight to COGS the day it was coded, so
 * the beer brewed from it has ALREADY been charged. Costing it again when it
 * sells books the same ingredients twice — and because the shelves never gave
 * that beer up, the inventory residual (GL 6460) booked a matching "gain" of
 * exactly that amount every month pre-tracking beer sold (≈$3.5k/month in
 * Aug–Oct 2026). A batch whose brew date (planned_brew_date, else created_at;
 * a conversion child follows its root parent) falls before the first tracked
 * month therefore carries NO beer cost here. Its packaging still does: cans
 * and PakTechs leave the packaging shelf the day the beer is packaged, which
 * can be well after the brew.
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
  /** Batches brewed before inventory tracking began: their beer is already a cost, so it carries none here. */
  expensedBatchIds: ReadonlySet<string> = new Set(),
): CostOfBeerSoldByMonth {
  const out: CostOfBeerSoldByMonth = {};
  for (const m of months) out[m] = { beerCents: 0, packagingCents: 0, ids: [] };

  for (const r of rows) {
    const month = r.created_at.slice(0, 7);
    const bucket = out[month];
    if (!bucket) continue;

    const bbl = Number(r.volume_bbl ?? 0);
    const batch = r.batch_id ? batchCosts.get(r.batch_id) : undefined;
    const alreadyExpensed = r.batch_id !== null && expensedBatchIds.has(r.batch_id);
    const perBbl = alreadyExpensed ? 0
      : batch && batch.costPerBblCents > 0
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

export interface BatchDateRow {
  id: string;
  planned_brew_date: string | null;
  created_at: string;
  converted_from_batch_id: string | null;
}

/**
 * Pure: the batches brewed before `trackedFrom` ("YYYY-MM"), whose ingredients
 * were expensed when bought. A conversion child is as old as its root parent —
 * the beer in it was brewed then, whatever day the conversion was recorded.
 * No tracking month → nothing is pre-tracking.
 */
export function preTrackingBatchIds(batches: readonly BatchDateRow[], trackedFrom: string | null): Set<string> {
  const out = new Set<string>();
  if (!trackedFrom) return out;
  const cutoff = `${trackedFrom}-01`;
  const byId = new Map(batches.map((b) => [b.id, b]));
  const brewDate = (b: BatchDateRow): string => (b.planned_brew_date ?? b.created_at).slice(0, 10);
  for (const b of batches) {
    let root = b;
    const seen = new Set<string>([b.id]);
    while (root.converted_from_batch_id) {
      const parent = byId.get(root.converted_from_batch_id);
      if (!parent || seen.has(parent.id)) break;
      seen.add(parent.id);
      root = parent;
    }
    if (brewDate(root) < cutoff) out.add(b.id);
  }
  return out;
}

export async function fetchCostOfBeerSoldByMonth(
  supabase: SupabaseClient,
  months: string[],
  /** First month inventory has a value (inventoryRelief.firstTrackedMonth); beer brewed before it carries no cost. */
  trackedFrom: string | null = null,
): Promise<CostOfBeerSoldByMonth> {
  if (months.length === 0) return {};
  const first = `${months[0]}-01`;
  const last = monthEnd(`${months[months.length - 1]}-01`);

  const [rows, variations, items, recipeCost, batchCosts, batches] = await Promise.all([
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
    fetchAllRows<BatchDateRow>(() =>
      supabase
        .from("brew_batches")
        .select("id, planned_brew_date, created_at, converted_from_batch_id")
        .order("id", { ascending: true }),
    ),
  ]);

  return costSoldRows(
    rows,
    months,
    batchCosts,
    recipeCost.perBbl,
    new Map(variations.map((v: PackagingVariationRow) => [v.id, v])),
    new Map(items.map((i: PackagingItemRow) => [i.id, i])),
    preTrackingBatchIds(batches, trackedFrom),
  );
}

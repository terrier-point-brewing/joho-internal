/**
 * Valuing the physical inventory the brewery holds, at what it paid for it —
 * the arithmetic behind the balance sheet's "Inventory on hand" method.
 *
 * ── Why this lives outside lib/finance/balances ──────────────────────────────
 * Two readers need the same valuation and sit on opposite sides of the
 * statement-isolation boundary (scripts/check-statement-isolation.mjs): the
 * balance-sheet provider (lib/finance/balances/providers/inventoryOnHand.ts),
 * which may import anything, and the P&L's inventory-relief rows
 * (lib/finance/inventoryRelief.ts), which feed the frozen P&L path and must
 * not reach into the balances tree. Hoisting the arithmetic here lets both
 * import it without either a second implementation or a boundary violation.
 * The provider file keeps the method-facing commentary (pools, partner stock,
 * standard cost); this file is the arithmetic it describes.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { BBL_TO_FL_OZ } from "@/lib/constants/production";
import { computeMaterialCost } from "@/lib/production/packagingMaterials";
import type { MaterialComponent, MaterialRole } from "@/lib/production/packagingMaterials";

/** The shelves that can be valued from cost data this business actually keeps. */
export const INVENTORY_POOLS = ["rawMaterials", "packagingMaterials", "finishedGoods"] as const;
export type InventoryPool = (typeof INVENTORY_POOLS)[number];

export function inventoryPoolOf(raw: unknown): InventoryPool | null {
  return typeof raw === "string" && (INVENTORY_POOLS as readonly string[]).includes(raw) ? (raw as InventoryPool) : null;
}

interface CostedRow {
  quantity: number | null;
  cost: number | null;
}

/**
 * Extended value of a shelf, in cents.
 *
 * A row missing either half is worth 0 rather than throwing: an ingredient
 * somebody added before pricing it is a real and ordinary state, and refusing to
 * value the whole account over one unpriced sack would take the other 67 down
 * with it. It does mean the figure understates rather than errors -- which is
 * why the method's step description says so out loud.
 */
function extendedCents(rows: CostedRow[]): number {
  const dollars = rows.reduce((sum, r) => sum + (r.quantity ?? 0) * (r.cost ?? 0), 0);
  return Math.round(dollars * 100);
}

export async function fetchRawMaterialsCents(supabase: SupabaseClient): Promise<number> {
  const rows = await fetchAllRows<{ stock_quantity: number | null; cost_per_unit_usd: number | null }>(() =>
    supabase.from("ingredients").select("stock_quantity, cost_per_unit_usd").order("id", { ascending: true }),
  );
  return extendedCents(rows.map((r) => ({ quantity: r.stock_quantity, cost: r.cost_per_unit_usd })));
}

export async function fetchPackagingMaterialsCents(supabase: SupabaseClient): Promise<number> {
  const rows = await fetchAllRows<{ stock_quantity: number | null; unit_cost_usd: number | null }>(() =>
    supabase
      .from("packaging_items")
      .select("stock_quantity, unit_cost_usd")
      .is("partner_id", null)
      .order("id", { ascending: true }),
  );
  return extendedCents(rows.map((r) => ({ quantity: r.stock_quantity, cost: r.unit_cost_usd })));
}

// ── Finished goods ───────────────────────────────────────────────────────────
//
// Packaged beer sitting in cold storage, at what it cost to make.
//
// ── Everything in cold storage is this business's own stock ──────────────────
// Deliberately NOT filtered by the recipe's contract-brewing partner, which is
// the opposite of the packaging shelf above and is the rule that matters most
// here. Ownership passes to a partner when beer LEAVES on a shipment, not when
// it is brewed to their recipe -- so a partner's beer still in cold storage is
// this brewery's asset and belongs on this balance sheet. Filtering by
// partner_id would today remove the entire account (every cold-storage batch is
// against a partner recipe) and, worse, would look like a deliberate accounting
// rule rather than the mistake it is.
//
// ── Standard cost, not actual batch cost ─────────────────────────────────────
// The obvious approach is to add up what each batch actually consumed. It does
// not work here: of the 23 batches in cold storage, ZERO have ingredient
// consumption rows and only 9 have packaging rows -- those ledgers only begin in
// July 2026. An actual-cost valuation would therefore report almost the whole
// account as worthless, confidently. So cost is derived from the recipe and the
// packaging variation instead, which is the same basis used to bill contract
// partners for materials.
//
// ── Materials only ───────────────────────────────────────────────────────────
// No labor, no brewery overhead. Full absorption costing needs a per-bbl rate
// this business does not record, and inventing one would be a worse number than
// omitting it. The effect is to understate, never to inflate.

interface ColdStorageRow {
  recipe_id: string | null;
  variation_id: string | null;
  quantity_on_hand: number | null;
}

interface VariationRow {
  id: string;
  format: string | null;
  total_volume_fl_oz: number | null;
  container_id: string | null;
  lid_id: string | null;
  label_id: string | null;
  paktech_id: string | null;
  tray_id: string | null;
}

interface PackagingItemRow {
  id: string;
  type: string | null;
  name: string | null;
  unit_cost_usd: number | null;
  can_count: number | null;
}

/** Recipe material cost per bbl, from the ingredient bill at today's ingredient prices. */
async function fetchRecipeCostPerBbl(supabase: SupabaseClient): Promise<Map<string, number>> {
  const rows = await fetchAllRows<{
    recipe_id: string;
    quantity_per_bbl: number | null;
    ingredients: { cost_per_unit_usd: number | null } | null;
  }>(() =>
    supabase
      .from("recipe_ingredients")
      .select("recipe_id, quantity_per_bbl, ingredients ( cost_per_unit_usd )")
      .order("id", { ascending: true }),
  );

  const byRecipe = new Map<string, number>();
  for (const row of rows) {
    const line = (row.quantity_per_bbl ?? 0) * (row.ingredients?.cost_per_unit_usd ?? 0);
    byRecipe.set(row.recipe_id, (byRecipe.get(row.recipe_id) ?? 0) + line);
  }
  return byRecipe;
}

/**
 * How many containers one package holds -- a case's tray count, a 4/6-pack's
 * PakTech count, otherwise one. Same rule as packagingVariations.ts's
 * getUnitsPerPackage, applied to items already fetched rather than re-queried.
 */
function unitsPerPackage(variation: VariationRow, items: Map<string, PackagingItemRow>): number {
  if (variation.format === "case" && variation.tray_id) return items.get(variation.tray_id)?.can_count ?? 1;
  if ((variation.format === "4-pack" || variation.format === "6-pack") && variation.paktech_id) {
    return items.get(variation.paktech_id)?.can_count ?? 1;
  }
  return 1;
}

/**
 * The consumed packaging components of one variation, in the shape
 * computeMaterialCost expects.
 *
 * A KEG container is excluded. A keg is a returnable vessel that comes back and
 * gets refilled, not packaging consumed by the beer inside it -- its cost
 * belongs to the keg float, not to this month's finished goods. Every keg is
 * unpriced today, so this changes no figure now; it exists so that pricing one
 * for some other purpose cannot silently inflate the balance sheet.
 */
function componentsOf(variation: VariationRow, items: Map<string, PackagingItemRow>): MaterialComponent[] {
  const slots: [MaterialRole, string | null][] = [
    ["container", variation.container_id],
    ["lid", variation.lid_id],
    ["label", variation.label_id],
    ["paktech", variation.paktech_id],
    ["tray", variation.tray_id],
  ];

  const components: MaterialComponent[] = [];
  for (const [role, id] of slots) {
    if (!id) continue;
    const item = items.get(id);
    if (!item) continue;
    if (role === "container" && item.type === "keg") continue;
    components.push({
      role,
      name: item.name ?? role,
      unitCostDollars: item.unit_cost_usd,
      canCount: item.can_count,
    });
  }
  return components;
}

export async function fetchFinishedGoodsCents(supabase: SupabaseClient): Promise<number> {
  const stock = await fetchAllRows<ColdStorageRow>(() =>
    supabase
      .from("cold_storage_inventory")
      .select("recipe_id, variation_id, quantity_on_hand")
      .order("id", { ascending: true }),
  );
  if (stock.length === 0) return 0;

  const [variations, costPerBbl] = await Promise.all([
    fetchAllRows<VariationRow>(() =>
      supabase
        .from("packaging_variations")
        .select("id, format, total_volume_fl_oz, container_id, lid_id, label_id, paktech_id, tray_id")
        .order("id", { ascending: true }),
    ),
    fetchRecipeCostPerBbl(supabase),
  ]);
  const variationsById = new Map(variations.map((v) => [v.id, v]));

  const items = await fetchAllRows<PackagingItemRow>(() =>
    supabase.from("packaging_items").select("id, type, name, unit_cost_usd, can_count").order("id", { ascending: true }),
  );
  const itemsById = new Map(items.map((i) => [i.id, i]));

  let cents = 0;
  for (const row of stock) {
    const quantity = row.quantity_on_hand ?? 0;
    if (quantity <= 0) continue;
    const variation = row.variation_id ? variationsById.get(row.variation_id) : undefined;
    if (!variation) continue;

    // The beer itself: recipe cost per bbl, scaled by how much beer this unit
    // holds. total_volume_fl_oz is already the whole unit -- a case's full 24
    // cans -- so no per-package multiplier belongs here.
    const bbl = (variation.total_volume_fl_oz ?? 0) / BBL_TO_FL_OZ;
    const beerDollars = quantity * bbl * (row.recipe_id ? (costPerBbl.get(row.recipe_id) ?? 0) : 0);

    // The packaging around it, through the same engine the export invoices bill
    // from -- so a case's trays, PakTechs and 24 lids are counted the way they
    // are counted everywhere else, rather than re-derived here and drifting.
    const { totalCents: packagingCents } = computeMaterialCost([
      {
        format: variation.format ?? "loose",
        packages: quantity,
        unitsPerPackage: unitsPerPackage(variation, itemsById),
        components: componentsOf(variation, itemsById),
      },
    ]);

    cents += Math.round(beerDollars * 100) + packagingCents;
  }
  return cents;
}


/** One shelf's value today, in cents — the dispatcher both readers share. */
export function valueInventoryPoolCents(supabase: SupabaseClient, pool: InventoryPool): Promise<number> {
  if (pool === "rawMaterials") return fetchRawMaterialsCents(supabase);
  if (pool === "packagingMaterials") return fetchPackagingMaterialsCents(supabase);
  return fetchFinishedGoodsCents(supabase);
}

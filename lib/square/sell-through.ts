import { fetchCurrentCounts, fetchOrderSales } from "@/lib/square/inventory";
import { BBL_TO_FL_OZ } from "@/lib/constants/production";
import { fetchDailyPourSellThrough } from "@/lib/taproom/draftPourConsumption";

export const SELL_THROUGH_WINDOW_DAYS = 30;

export interface LinkSellThrough {
  link_id: string;
  recipe_id: string;
  packaging: "draft" | "keg" | "can";
  packaging_item_id: string | null;
  packaging_item_name: string | null;
  // The Square variation ID that is linked (base "Draft"/"Regular" variation)
  square_variation_id: string;
  variation_name: string | null;
  item_name: string | null;
  // null for draft (keg inventory is fl oz, not a fixed per-unit volume)
  volume_fl_oz: number | null;
  // draft: fl oz remaining in keg. keg/can: unit count.
  current_qty: number;
  current_bbl: number;
  daily_sell_through_units: number;
  daily_sell_through_bbl: number;
  recipe: {
    beer_name: string;
    days_brewhouse: number | null;
    days_fermenter: number | null;
    days_brite: number | null;
  } | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbClient = { from: (table: string) => any };

/**
 * Fetch per-link sell-through metrics for all (or a single) packaging type.
 *
 * Draft:   keg inventory (current_qty/current_bbl) is tracked in fl oz on the
 *          base variation via Square live counts. Daily sell-through comes
 *          from the pour-consumption ledger (lib/taproom/draftPourConsumption)
 *          instead of summing pour-size sibling sales inline.
 * Keg/Can: inventory and sales are on the single linked variation; volume is
 *          from packaging_items or parsed from the variation name.
 */
export async function fetchSellThrough(
  supabase: DbClient,
  options: { packaging?: "draft" | "keg" | "can"; windowDays?: number } = {},
): Promise<LinkSellThrough[]> {
  const { packaging, windowDays = SELL_THROUGH_WINDOW_DAYS } = options;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q = (supabase as any)
    .from("recipe_square_links")
    .select(
      "id, packaging, packaging_item_id, square_variation_id, square_item_id, " +
      "variation_name, item_name, recipe_id, " +
      "recipes(beer_name, days_brewhouse, days_fermenter, days_brite), " +
      "packaging_items(id, name, type, volume_fl_oz)",
    );
  if (packaging) q = q.eq("packaging", packaging);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: links, error } = await q as { data: any[] | null; error: { message: string } | null };
  if (error) throw new Error(error.message);
  if (!links || links.length === 0) return [];

  const baseVarIds: string[] = [...new Set(links.map((l) => l.square_variation_id as string))];

  // Per-sold-unit volume comes from the catalog mirror (populated by the sync
  // route via lib/square/catalogUnits.ts) instead of re-parsing variation names.
  const { data: unitRows } = await supabase
    .from("square_catalog_variations")
    .select("square_variation_id, volume_fl_oz_per_unit")
    .in("square_variation_id", baseVarIds);
  const volPerUnitByVarId = new Map<string, number | null>();
  for (const r of unitRows ?? []) {
    volPerUnitByVarId.set(r.square_variation_id as string, (r.volume_fl_oz_per_unit as number | null) ?? null);
  }

  const now = new Date();
  const windowStart = new Date(now.getTime() - windowDays * 86400000);

  // Draft daily sell-through comes from the pour-consumption ledger, not order
  // sales, so only fetch it when draft links are in scope for this query.
  const wantsDraft = packaging === undefined || packaging === "draft";

  const [currentCounts, salesTotals, pourDaily] = await Promise.all([
    fetchCurrentCounts(baseVarIds),
    fetchOrderSales(
      windowStart.toISOString().slice(0, 10),
      now.toISOString().slice(0, 10),
      baseVarIds,
    ),
    wantsDraft
      ? fetchDailyPourSellThrough(supabase, windowDays)
      : Promise.resolve(new Map<string, { dailyFlOz: number; dailyUnits: number }>()),
  ]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return collapseSharedSkuLinks(links.map((l: any): LinkSellThrough => {
    const qty = currentCounts.get(l.square_variation_id as string) ?? 0;

    if (l.packaging === "draft") {
      // qty = fl oz remaining in keg (Square tracks this directly on the base variation)
      const currentBbl = qty / BBL_TO_FL_OZ;

      // Daily sell-through comes from the pour-consumption ledger (Task 2/3),
      // keyed by recipe, not from summing pour-size sibling order sales.
      const daily = pourDaily.get(l.recipe_id as string) ?? { dailyFlOz: 0, dailyUnits: 0 };

      return {
        link_id:                   l.id,
        recipe_id:                 l.recipe_id,
        packaging:                 "draft",
        packaging_item_id:         l.packaging_item_id,
        packaging_item_name:       l.packaging_items?.name ?? null,
        square_variation_id:       l.square_variation_id,
        variation_name:            l.variation_name,
        item_name:                 l.item_name,
        volume_fl_oz:              null,
        current_qty:               qty,
        current_bbl:               Number(currentBbl.toFixed(4)),
        daily_sell_through_units:  Number(daily.dailyUnits.toFixed(2)),
        daily_sell_through_bbl:    Number((daily.dailyFlOz / BBL_TO_FL_OZ).toFixed(4)),
        recipe:                    l.recipes ?? null,
      };
    }

    // Keg and can: qty is unit count; volume_fl_oz converts to bbl.
    const totalSold = salesTotals.get(l.square_variation_id as string) ?? 0;
    const dailyUnits = totalSold / windowDays;

    let volFlOz: number | null = null;
    if (l.packaging === "keg") {
      volFlOz = l.packaging_items?.volume_fl_oz ?? null;
    } else {
      // can: total oz per sold unit comes from the mirror, falling back to the
      // packaging_items container volume if the mirror has no parsed value.
      volFlOz = volPerUnitByVarId.get(l.square_variation_id as string) ?? l.packaging_items?.volume_fl_oz ?? null;
    }

    const unitsToBbl = (units: number) => volFlOz ? (units * volFlOz) / BBL_TO_FL_OZ : 0;

    return {
      link_id:                   l.id,
      recipe_id:                 l.recipe_id,
      packaging:                 l.packaging,
      packaging_item_id:         l.packaging_item_id,
      packaging_item_name:       l.packaging_items?.name ?? null,
      square_variation_id:       l.square_variation_id,
      variation_name:            l.variation_name,
      item_name:                 l.item_name,
      volume_fl_oz:              volFlOz,
      current_qty:               qty,
      current_bbl:               Number(unitsToBbl(qty).toFixed(4)),
      daily_sell_through_units:  Number(dailyUnits.toFixed(2)),
      daily_sell_through_bbl:    Number(unitsToBbl(dailyUnits).toFixed(4)),
      recipe:                    l.recipes ?? null,
    };
  }));
}

/**
 * One row per Square SKU per recipe, for keg and can links.
 *
 * Every number above is read at SKU grain — Square's on-hand count and its order
 * sales are both keyed on square_variation_id — so two packagings mapped to one
 * button produce two rows carrying the SAME figures. Anything that sums them
 * (the taproom-inventory route adds current_bbl and daily_sell_through_bbl
 * across a recipe's links to get its stockout and brew-by dates) counts that
 * beer twice, and would push a brew-by date out by weeks.
 *
 * Collapsing keeps the first link's identity: which of two interchangeable
 * packagings labels the row does not change any figure on it.
 *
 * Draft is left alone. Those links are recipe-grain by construction
 * (rsl_draft_uniq), so there is nothing to collapse, and folding two recipes
 * that happened to share a draft SKU into one row would erase a real one.
 * Exported for unit testing.
 */
export function collapseSharedSkuLinks(links: LinkSellThrough[]): LinkSellThrough[] {
  const seen = new Set<string>();
  const out: LinkSellThrough[] = [];
  for (const l of links) {
    if (l.packaging === "draft") {
      out.push(l);
      continue;
    }
    const key = `${l.recipe_id}\t${l.square_variation_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out;
}

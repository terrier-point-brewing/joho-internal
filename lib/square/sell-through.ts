import { fetchCurrentCounts, fetchOrderSales } from "@/lib/square/inventory";
import { BBL_TO_FL_OZ } from "@/lib/constants/production";
import { canOzPerUnit } from "@/lib/reports/bbl-tracker";

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

// Parse total fl oz represented by one unit sold of a variation.
// For draft pours the oz is in the name ("Draft - 16oz" → 16).
// For can multi-packs the oz and qty are both in the name ("12oz 4-Pack" → 48).
// Returns null when the serving size is unknown (base "Draft"/"Regular" variation).
function ozPerSale(name: string | null): number | null {
  if (!name) return null;
  const ozMatch = name.match(/(\d+(?:\.\d+)?)oz/i);
  if (!ozMatch) return null;
  const oz = parseFloat(ozMatch[1]);
  if (/\bcase\b/i.test(name)) return 24 * oz;
  const packMatch = name.match(/(\d+)[\s-]?(?:pack|pk)\b/i);
  if (packMatch) return parseInt(packMatch[1]) * oz;
  return oz;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbClient = { from: (table: string) => any };

/**
 * Fetch per-link sell-through metrics for all (or a single) packaging type.
 *
 * Draft:   keg inventory is tracked in fl oz on the base variation; pour-size
 *          sibling variations (Draft - 5oz, 10oz, 16oz) record actual taproom
 *          sales. Both are aggregated here.
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

  // For draft items, also load all pour-size sibling variations so we can
  // aggregate sales across every serving size (5oz, 10oz, 16oz, …).
  const draftItemIds: string[] = [
    ...new Set(
      links
        .filter((l) => l.packaging === "draft" && l.square_item_id)
        .map((l) => l.square_item_id as string),
    ),
  ];

  const draftVarsByItem = new Map<string, { id: string; oz: number | null }[]>();
  if (draftItemIds.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: siblings } = await (supabase as any)
      .from("square_catalog_variations")
      .select("square_variation_id, square_item_id, variation_name")
      .in("square_item_id", draftItemIds) as { data: any[] | null };
    for (const v of siblings ?? []) {
      const itemId = v.square_item_id as string;
      const list = draftVarsByItem.get(itemId) ?? [];
      list.push({ id: v.square_variation_id as string, oz: ozPerSale(v.variation_name as string | null) });
      draftVarsByItem.set(itemId, list);
    }
  }

  const allDraftSiblingIds = [...draftVarsByItem.values()].flatMap((vs) => vs.map((v) => v.id));
  // fetchCurrentCounts only needs base variation IDs (keg fl oz lives there).
  // fetchOrderSales needs all variation IDs so pour-size sales are captured.
  const allVarIds = [...new Set([...baseVarIds, ...allDraftSiblingIds])];

  const now = new Date();
  const windowStart = new Date(now.getTime() - windowDays * 86400000);

  const [currentCounts, salesTotals] = await Promise.all([
    fetchCurrentCounts(baseVarIds),
    fetchOrderSales(
      windowStart.toISOString().slice(0, 10),
      now.toISOString().slice(0, 10),
      allVarIds,
    ),
  ]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return links.map((l: any): LinkSellThrough => {
    const qty = currentCounts.get(l.square_variation_id as string) ?? 0;

    if (l.packaging === "draft") {
      // qty = fl oz remaining in keg (Square tracks this directly on the base variation)
      const currentBbl = qty / BBL_TO_FL_OZ;

      // Sum fl oz sold across all pour-size siblings; skip the base variation
      // (no oz in its name) since its per-pour oz is unknown.
      const siblings = draftVarsByItem.get(l.square_item_id as string) ?? [];
      let dailyFlOz = 0;
      let dailyUnits = 0;
      for (const sib of siblings) {
        const sold = salesTotals.get(sib.id) ?? 0;
        dailyUnits += sold / windowDays;
        if (sib.oz) dailyFlOz += (sold / windowDays) * sib.oz;
      }

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
        daily_sell_through_units:  Number(dailyUnits.toFixed(2)),
        daily_sell_through_bbl:    Number((dailyFlOz / BBL_TO_FL_OZ).toFixed(4)),
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
      // can: oz is in the variation name ("Regular - 12oz 4-Pack" → 48)
      volFlOz = l.variation_name ? canOzPerUnit(l.variation_name as string) : (l.packaging_items?.volume_fl_oz ?? null);
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
  });
}

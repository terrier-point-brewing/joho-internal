import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fetchCurrentCounts, fetchOrderSales } from "@/lib/square/inventory";
import { apiError } from "@/lib/utils/api";
import { BBL_TO_FL_OZ } from "@/lib/constants/production";

interface LinkRow {
  id: string;
  packaging: "draft" | "keg" | "can";
  packaging_item_id: string | null;
  square_variation_id: string;
  variation_name: string | null;
  item_name: string | null;
  recipe_id: string;
  recipes: {
    beer_name: string;
    days_brewhouse: number | null;
    days_fermenter: number | null;
    days_brite: number | null;
  } | null;
  packaging_items: {
    id: string;
    name: string;
    type: string;
    volume_fl_oz: number | null;
  } | null;
}

const WINDOW_DAYS = 28;
const MS_DAY = 86400000;

function unitsToBbl(qty: number, volumeFlOz: number | null): number {
  if (!volumeFlOz) return 0;
  return (qty * volumeFlOz) / BBL_TO_FL_OZ;
}

export async function GET() {
  const supabase = await createSupabaseServerClient();

  try {
    const { data: links, error } = await supabase
      .from("recipe_square_links")
      .select("id, packaging, packaging_item_id, square_variation_id, variation_name, item_name, recipe_id, recipes(beer_name, days_brewhouse, days_fermenter, days_brite), packaging_items(id, name, type, volume_fl_oz)")
      .returns<LinkRow[]>();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!links || links.length === 0) return NextResponse.json([]);

    const variationIds = [...new Set(links.map((l) => l.square_variation_id))];

    const end = new Date();
    const start = new Date(end.getTime() - WINDOW_DAYS * MS_DAY);

    const [current, salesTotals] = await Promise.all([
      fetchCurrentCounts(variationIds),
      fetchOrderSales(
        start.toISOString().slice(0, 10),
        end.toISOString().slice(0, 10),
        variationIds,
      ),
    ]);

    // Group all links by recipe_id — collapse keg + can + draft into one recipe row.
    const byRecipe = new Map<string, LinkRow[]>();
    for (const link of links) {
      const arr = byRecipe.get(link.recipe_id) ?? [];
      arr.push(link);
      byRecipe.set(link.recipe_id, arr);
    }

    const rows = [...byRecipe.entries()].map(([recipeId, recipeLinks]) => {
      const recipe = recipeLinks[0].recipes;
      const leadTimeDays = (recipe?.days_brewhouse ?? 0) + (recipe?.days_fermenter ?? 0) + (recipe?.days_brite ?? 0);

      // Per-packaging breakdown.
      const packagingBreakdown = recipeLinks.map((l) => {
        const qty = current.get(l.square_variation_id) ?? 0;
        // Units sold over the window, divided by window days → daily rate.
        const totalSold = salesTotals.get(l.square_variation_id) ?? 0;
        const dailySellThrough = totalSold / WINDOW_DAYS;

        const volFlOz = l.packaging_items?.volume_fl_oz ?? null;
        return {
          link_id: l.id,
          packaging: l.packaging,
          packaging_item_name: l.packaging_items?.name ?? null,
          variation_name: l.variation_name,
          item_name: l.item_name,
          volume_fl_oz: volFlOz,
          current_qty: qty,
          current_bbl: unitsToBbl(qty, volFlOz),
          daily_sell_through_units: Number(dailySellThrough.toFixed(2)),
          daily_sell_through_bbl: Number(unitsToBbl(dailySellThrough, volFlOz).toFixed(2)),
        };
      });

      // Aggregate to recipe level in BBL.
      const currentBbl = packagingBreakdown.reduce((s, p) => s + p.current_bbl, 0);
      const dailySellThroughBbl = packagingBreakdown.reduce((s, p) => s + p.daily_sell_through_bbl, 0);
      const minThresholdBbl = 1.5 * dailySellThroughBbl * leadTimeDays;

      let stockoutDate: string | null = null;
      let thresholdDate: string | null = null;
      let brewByDate: string | null = null;
      let neededBbl = 0;

      if (dailySellThroughBbl > 0) {
        stockoutDate = new Date(end.getTime() + (currentBbl / dailySellThroughBbl) * MS_DAY).toISOString().slice(0, 10);
        const daysToThreshold = (currentBbl - minThresholdBbl) / dailySellThroughBbl;
        if (daysToThreshold > 0) {
          thresholdDate = new Date(end.getTime() + daysToThreshold * MS_DAY).toISOString().slice(0, 10);
        }
        // How much to brew: enough to cover demand through the next production cycle.
        neededBbl = dailySellThroughBbl * (leadTimeDays + 7); // lead time + 1 week buffer
        if (stockoutDate && leadTimeDays > 0) {
          brewByDate = new Date(
            new Date(stockoutDate).getTime() - leadTimeDays * MS_DAY
          ).toISOString().slice(0, 10);
        }
      }

      // 4-week BBL history: fetch weekly sales totals per variation.
      // We use the pre-fetched salesTotals (28-day window) as a proxy for the trend sparkline.
      // For a proper weekly breakdown we'd need 4 separate API calls; instead we build
      // the sparkline from the single window total distributed evenly (flat line),
      // since the orders API doesn't return per-week breakdowns without extra calls.
      // The history is used for sparkline display only, not for any calculation.
      const recipeWeeklyBbl = packagingBreakdown.reduce((s, p) => s + unitsToBbl(p.daily_sell_through_units * 7, p.volume_fl_oz), 0);
      const historyBbl: { week: string; bbl: number | null }[] = [];
      for (let w = 4; w >= 1; w--) {
        const weekStart = end.getTime() - w * 7 * MS_DAY;
        historyBbl.push({
          week: new Date(weekStart).toISOString().slice(0, 10),
          bbl: recipeWeeklyBbl > 0 ? Number(recipeWeeklyBbl.toFixed(2)) : null,
        });
      }

      return {
        recipe_id: recipeId,
        style: recipe?.beer_name ?? "—",
        lead_time_days: leadTimeDays,
        current_bbl: Number(currentBbl.toFixed(2)),
        daily_sell_through_bbl: Number(dailySellThroughBbl.toFixed(4)),
        min_threshold_bbl: Number(minThresholdBbl.toFixed(2)),
        forecast_threshold_date: thresholdDate,
        forecast_stockout_date: stockoutDate,
        needed_bbl: Number(neededBbl.toFixed(2)),
        brew_by_date: brewByDate,
        history_bbl: historyBbl,
        packaging_breakdown: packagingBreakdown,
      };
    });

    return NextResponse.json(rows.sort((a, b) => {
      // Sort: styles with earlier stockouts first, then alphabetical.
      if (a.forecast_stockout_date && b.forecast_stockout_date) {
        return a.forecast_stockout_date.localeCompare(b.forecast_stockout_date);
      }
      if (a.forecast_stockout_date) return -1;
      if (b.forecast_stockout_date) return 1;
      return a.style.localeCompare(b.style);
    }));
  } catch (err) {
    return apiError(err);
  }
}

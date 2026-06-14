import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fetchSellThrough, SELL_THROUGH_WINDOW_DAYS } from "@/lib/square/sell-through";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

const MS_DAY = 86400000;

export async function GET() {
  const supabase = await createSupabaseServerClient();

  try {
    const [sellThrough, retiredRes] = await Promise.all([
      fetchSellThrough(supabase),
      supabase.from("taproom_recipe_settings").select("recipe_id, is_retired"),
    ]);

    if (sellThrough.length === 0) return NextResponse.json([]);

    const retiredMap = new Map(
      (retiredRes.data ?? []).map((r) => [r.recipe_id as string, Boolean(r.is_retired)])
    );

    // Group links by recipe
    const byRecipe = new Map<string, typeof sellThrough>();
    for (const link of sellThrough) {
      const arr = byRecipe.get(link.recipe_id) ?? [];
      arr.push(link);
      byRecipe.set(link.recipe_id, arr);
    }

    const end = new Date();

    const rows = [...byRecipe.entries()].map(([recipeId, recipeLinks]) => {
      const recipe = recipeLinks[0].recipe;
      const leadTimeDays =
        (recipe?.days_brewhouse ?? 0) +
        (recipe?.days_fermenter ?? 0) +
        (recipe?.days_brite ?? 0);

      const PACKAGING_ORDER: Record<string, number> = { draft: 0, keg: 1, can: 2 };

      const packagingBreakdown = recipeLinks
        .map((l) => ({
          link_id:                   l.link_id,
          packaging:                 l.packaging,
          packaging_item_name:       l.packaging_item_name,
          variation_name:            l.variation_name,
          item_name:                 l.item_name,
          volume_fl_oz:              l.volume_fl_oz,
          current_qty:               l.current_qty,
          current_bbl:               l.current_bbl,
          daily_sell_through_units:  l.daily_sell_through_units,
          daily_sell_through_bbl:    l.daily_sell_through_bbl,
        }))
        .sort((a, b) => {
          const po = (PACKAGING_ORDER[a.packaging] ?? 9) - (PACKAGING_ORDER[b.packaging] ?? 9);
          if (po !== 0) return po;
          // Within kegs: sort alphabetically by size name (1/2 < 1/4 < 1/6 = largest first)
          return (a.packaging_item_name ?? "").localeCompare(b.packaging_item_name ?? "");
        });

      const currentBbl         = packagingBreakdown.reduce((s, p) => s + p.current_bbl, 0);
      const dailySellThroughBbl = packagingBreakdown.reduce((s, p) => s + p.daily_sell_through_bbl, 0);
      const minThresholdBbl    = 1.5 * dailySellThroughBbl * leadTimeDays;

      let stockoutDate: string | null = null;
      let thresholdDate: string | null = null;
      let brewByDate: string | null = null;
      let neededBbl = 0;

      if (dailySellThroughBbl > 0) {
        stockoutDate = new Date(
          end.getTime() + (currentBbl / dailySellThroughBbl) * MS_DAY
        ).toISOString().slice(0, 10);

        const daysToThreshold = (currentBbl - minThresholdBbl) / dailySellThroughBbl;
        if (daysToThreshold > 0) {
          thresholdDate = new Date(end.getTime() + daysToThreshold * MS_DAY)
            .toISOString()
            .slice(0, 10);
        }

        neededBbl = dailySellThroughBbl * (leadTimeDays + 7);
        if (stockoutDate && leadTimeDays > 0) {
          brewByDate = new Date(
            new Date(stockoutDate).getTime() - leadTimeDays * MS_DAY
          ).toISOString().slice(0, 10);
        }
      }

      // Sparkline: 4 weeks of weekly bbl (flat from the 90-day average)
      const weeklyBbl = dailySellThroughBbl * 7;
      const historyBbl: { week: string; bbl: number | null }[] = [];
      for (let w = 4; w >= 1; w--) {
        historyBbl.push({
          week: new Date(end.getTime() - w * 7 * MS_DAY).toISOString().slice(0, 10),
          bbl:  weeklyBbl > 0 ? Number(weeklyBbl.toFixed(2)) : null,
        });
      }

      return {
        recipe_id:                recipeId,
        style:                    recipe?.beer_name ?? "—",
        lead_time_days:           leadTimeDays,
        current_bbl:              Number(currentBbl.toFixed(2)),
        daily_sell_through_bbl:   Number(dailySellThroughBbl.toFixed(4)),
        min_threshold_bbl:        Number(minThresholdBbl.toFixed(2)),
        forecast_threshold_date:  thresholdDate,
        forecast_stockout_date:   stockoutDate,
        needed_bbl:               Number(neededBbl.toFixed(2)),
        brew_by_date:             brewByDate,
        history_bbl:              historyBbl,
        packaging_breakdown:      packagingBreakdown,
        is_retired:               retiredMap.get(recipeId) ?? false,
        sell_through_window_days: SELL_THROUGH_WINDOW_DAYS,
      };
    });

    return NextResponse.json(rows.sort((a, b) => a.style.localeCompare(b.style)));
  } catch (err) {
    return apiError(err);
  }
}

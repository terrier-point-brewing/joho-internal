import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { fetchCurrentCounts, fetchPhysicalCounts } from "@/lib/square/inventory";
import { apiError } from "@/lib/utils/api";

interface LinkRow {
  id: string;
  packaging: "draft" | "keg" | "can";
  square_variation_id: string;
  recipe_id: string;
  recipes: {
    beer_name: string;
    days_brewhouse: number | null;
    days_fermenter: number | null;
    days_brite: number | null;
  } | null;
}

const WINDOW_DAYS = 28;
const MS_DAY = 86400000;

export async function GET() {
  try {
    const { data: links, error } = await supabase
      .from("recipe_square_links")
      .select("id, packaging, square_variation_id, recipe_id, recipes(beer_name, days_brewhouse, days_fermenter, days_brite)")
      .returns<LinkRow[]>();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!links || links.length === 0) return NextResponse.json([]);

    const variationIds = [...new Set(links.map((l) => l.square_variation_id))];

    const end = new Date();
    const start = new Date(end.getTime() - WINDOW_DAYS * MS_DAY);
    const startStr = start.toISOString().slice(0, 10);
    const endStr = end.toISOString().slice(0, 10);

    const [current, physical] = await Promise.all([
      fetchCurrentCounts(variationIds),
      fetchPhysicalCounts(startStr, endStr),
    ]);

    // Group physical counts by variation, sorted ascending by occurrence.
    const countsByVariation = new Map<string, { t: number; qty: number }[]>();
    for (const pc of physical) {
      if (!variationIds.includes(pc.catalog_object_id)) continue;
      const arr = countsByVariation.get(pc.catalog_object_id) ?? [];
      arr.push({ t: new Date(pc.occurred_at).getTime(), qty: Number(pc.quantity) });
      countsByVariation.set(pc.catalog_object_id, arr);
    }

    const rows = links.map((link) => {
      const vid = link.square_variation_id;
      const currentQty = current.get(vid) ?? 0;
      const series = (countsByVariation.get(vid) ?? []).sort((a, b) => a.t - b.t);

      // 4 weekly buckets: latest count observed within each week before today.
      const history: { week: string; qty: number | null }[] = [];
      for (let w = 4; w >= 1; w--) {
        const weekEnd = end.getTime() - (w - 1) * 7 * MS_DAY;
        const weekStart = end.getTime() - w * 7 * MS_DAY;
        const inWeek = series.filter((s) => s.t > weekStart && s.t <= weekEnd);
        const qty = inWeek.length ? inWeek[inWeek.length - 1].qty : null;
        history.push({ week: new Date(weekStart).toISOString().slice(0, 10), qty });
      }

      // Sell-through: average daily decline across the observed window.
      let dailySellThrough = 0;
      if (series.length >= 2) {
        const first = series[0];
        const last = series[series.length - 1];
        const days = Math.max((last.t - first.t) / MS_DAY, 1);
        const decline = first.qty - last.qty;
        if (decline > 0) dailySellThrough = decline / days;
      }

      const r = link.recipes;
      const leadTimeDays = (r?.days_brewhouse ?? 0) + (r?.days_fermenter ?? 0) + (r?.days_brite ?? 0);
      const minThreshold = 1.5 * dailySellThrough * leadTimeDays;

      let stockoutDate: string | null = null;
      let thresholdDate: string | null = null;
      if (dailySellThrough > 0) {
        stockoutDate = new Date(end.getTime() + (currentQty / dailySellThrough) * MS_DAY)
          .toISOString().slice(0, 10);
        const daysToThreshold = (currentQty - minThreshold) / dailySellThrough;
        thresholdDate = new Date(end.getTime() + Math.max(daysToThreshold, 0) * MS_DAY)
          .toISOString().slice(0, 10);
      }

      return {
        link_id: link.id,
        recipe_id: link.recipe_id,
        style: r?.beer_name ?? "—",
        packaging: link.packaging,
        current_qty: currentQty,
        history,
        daily_sell_through: Number(dailySellThrough.toFixed(2)),
        lead_time_days: leadTimeDays,
        min_threshold: Number(minThreshold.toFixed(1)),
        forecast_threshold_date: thresholdDate,
        forecast_stockout_date: stockoutDate,
      };
    });

    return NextResponse.json(rows);
  } catch (err) {
    return apiError(err);
  }
}

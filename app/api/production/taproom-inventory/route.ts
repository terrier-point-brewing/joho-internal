import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { fetchCurrentCounts, fetchPhysicalCounts } from "@/lib/square/inventory";
import { apiError } from "@/lib/utils/api";

interface LinkRow {
  id: string;
  packaging: "draft" | "keg" | "can";
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
}

const WINDOW_DAYS = 28;
const MS_DAY = 86400000;

export async function GET() {
  try {
    const { data: links, error } = await supabase
      .from("recipe_square_links")
      .select("id, packaging, square_variation_id, variation_name, item_name, recipe_id, recipes(beer_name, days_brewhouse, days_fermenter, days_brite)")
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

    // Group physical counts by variation, sorted ascending.
    const countsByVariation = new Map<string, { t: number; qty: number }[]>();
    for (const pc of physical) {
      if (!variationIds.includes(pc.catalog_object_id)) continue;
      const arr = countsByVariation.get(pc.catalog_object_id) ?? [];
      arr.push({ t: new Date(pc.occurred_at).getTime(), qty: Number(pc.quantity) });
      countsByVariation.set(pc.catalog_object_id, arr);
    }

    // Group links by recipe_id + packaging to aggregate.
    type GroupKey = string; // `${recipe_id}:${packaging}`
    const groups = new Map<GroupKey, LinkRow[]>();
    for (const link of links) {
      const key = `${link.recipe_id}:${link.packaging}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(link);
    }

    const rows = [...groups.entries()].map(([, groupLinks]) => {
      const first = groupLinks[0];
      const r = first.recipes;

      // Aggregate current qty and per-variation breakdown.
      const variations = groupLinks.map((l) => ({
        link_id: l.id,
        variation_name: l.variation_name,
        item_name: l.item_name,
        qty: current.get(l.square_variation_id) ?? 0,
      }));
      const currentQty = variations.reduce((s, v) => s + v.qty, 0);

      // Aggregate history: sum across all variations per week bucket.
      const history: { week: string; qty: number | null }[] = [];
      for (let w = 4; w >= 1; w--) {
        const weekEnd = end.getTime() - (w - 1) * 7 * MS_DAY;
        const weekStart = end.getTime() - w * 7 * MS_DAY;
        let weekSum: number | null = null;
        for (const l of groupLinks) {
          const series = (countsByVariation.get(l.square_variation_id) ?? []);
          const inWeek = series.filter((s) => s.t > weekStart && s.t <= weekEnd);
          if (inWeek.length > 0) {
            weekSum = (weekSum ?? 0) + inWeek[inWeek.length - 1].qty;
          }
        }
        history.push({ week: new Date(weekStart).toISOString().slice(0, 10), qty: weekSum });
      }

      // Sell-through: aggregate decline across all variations.
      let dailySellThrough = 0;
      for (const l of groupLinks) {
        const series = (countsByVariation.get(l.square_variation_id) ?? []).sort((a, b) => a.t - b.t);
        if (series.length >= 2) {
          const fst = series[0];
          const lst = series[series.length - 1];
          const days = Math.max((lst.t - fst.t) / MS_DAY, 1);
          const decline = fst.qty - lst.qty;
          if (decline > 0) dailySellThrough += decline / days;
        }
      }

      const leadTimeDays = (r?.days_brewhouse ?? 0) + (r?.days_fermenter ?? 0) + (r?.days_brite ?? 0);
      const minThreshold = 1.5 * dailySellThrough * leadTimeDays;

      let stockoutDate: string | null = null;
      let thresholdDate: string | null = null;
      if (dailySellThrough > 0) {
        stockoutDate = new Date(end.getTime() + (currentQty / dailySellThrough) * MS_DAY).toISOString().slice(0, 10);
        const daysToThreshold = (currentQty - minThreshold) / dailySellThrough;
        thresholdDate = new Date(end.getTime() + Math.max(daysToThreshold, 0) * MS_DAY).toISOString().slice(0, 10);
      }

      return {
        recipe_id: first.recipe_id,
        style: r?.beer_name ?? "—",
        packaging: first.packaging,
        current_qty: currentQty,
        history,
        daily_sell_through: Number(dailySellThrough.toFixed(2)),
        lead_time_days: leadTimeDays,
        min_threshold: Number(minThreshold.toFixed(1)),
        forecast_threshold_date: thresholdDate,
        forecast_stockout_date: stockoutDate,
        variations,
      };
    });

    return NextResponse.json(rows);
  } catch (err) {
    return apiError(err);
  }
}

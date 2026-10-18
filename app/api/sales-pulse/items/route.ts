import { NextRequest, NextResponse } from "next/server";
import { fetchCatalogItems } from "@/lib/square/catalog";
import { fetchCompletedOrders } from "@/lib/square/orders";
import { fetchRefunds } from "@/lib/square/refunds";
import { buildTaproomModelReport } from "@/lib/reports/taproom-model";
import { buildItemSalesData } from "@/lib/reports/itemSales";
import { resolveTrendWindow } from "@/lib/reports/draftTrend";
import { isInvoiceOrder } from "@/lib/square/invoiceOrders";
import { getBreweryTimezone } from "@/lib/settings/breweryTimezone.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { volumeFlOzPerUnit } from "@/lib/square/catalogUnits";
import type { CatalogItem } from "@/types/square";
import { todayLocalDate, addDaysStr } from "@/lib/utils/datetime";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

// Per-item daily sales events for Taproom → Performance → Items, over
// `?range=<days>` ending today, or `?start&end` (brewery-local). Same order fetch and invoice
// filter as ../route.ts and ../lines/route.ts, so an item's total here is the
// sum of the lines its transaction drill (./lines) shows.
//
// Aggregated to item-days server-side: a year is tens of thousands of lines,
// far more than the browser needs to draw a chart and a table.
//
// Fl oz per unit comes from the catalog mirror's `volume_fl_oz_per_unit` where
// set, else from the variation name — the same two sources the draft pour
// ledger reads — so the fl oz view agrees with what Draft Stats used to show.
async function buildFlOzResolver(items: CatalogItem[]) {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("square_catalog_variations")
    .select("square_variation_id, volume_fl_oz_per_unit")
    .not("volume_fl_oz_per_unit", "is", null);
  const override = new Map<string, number>();
  for (const r of (data ?? []) as { square_variation_id: string; volume_fl_oz_per_unit: number | string }[]) {
    override.set(r.square_variation_id, Number(r.volume_fl_oz_per_unit));
  }
  const byName = new Map<string, number | null>();
  for (const it of items) {
    for (const v of it.item_data.variations ?? []) {
      const name = v.item_variation_data?.name ?? "";
      byName.set(`${it.item_data.name}\u0000${name}`, override.get(v.id) ?? volumeFlOzPerUnit(name));
    }
  }
  return (itemName: string, variationName: string) =>
    byName.get(`${itemName}\u0000${variationName}`) ?? volumeFlOzPerUnit(variationName);
}

export async function GET(req: NextRequest) {
  try {
    const tz = await getBreweryTimezone();
    const w = resolveTrendWindow(new URL(req.url).searchParams, 90, todayLocalDate(tz));
    // "All time" against Square is unbounded; two years is as far as anyone looks.
    const start = w.start ?? addDaysStr(w.end, -729);
    const end = w.end;

    const [catalogItems, allOrders, refunds] = await Promise.all([
      fetchCatalogItems(),
      fetchCompletedOrders(start, end),
      fetchRefunds(start, end),
    ]);

    const orders = allOrders.filter((o) => !isInvoiceOrder(o));
    const { contributions } = buildTaproomModelReport(orders, catalogItems, refunds);
    const flOzFor = await buildFlOzResolver(catalogItems);

    return NextResponse.json(buildItemSalesData(contributions, start, end, tz, flOzFor));
  } catch (err) {
    return apiError(err);
  }
}

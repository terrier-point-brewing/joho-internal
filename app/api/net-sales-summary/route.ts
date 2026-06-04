import { NextRequest, NextResponse } from "next/server";
import { fetchCatalogItems } from "@/lib/square/catalog";
import { fetchCompletedOrders } from "@/lib/square/orders";
import { fetchRefunds } from "@/lib/square/refunds";
import { buildTaproomModelReport } from "@/lib/reports/taproom-model";
import { requireDateRange, apiError } from "@/lib/utils/api";
import { supabase } from "@/lib/supabase/client";

export async function GET(req: NextRequest) {
  const range = requireDateRange(req);
  if (range instanceof NextResponse) return range;
  const { start, end } = range;

  try {
    // -----------------------------------------------------------------------
    // 1. Square POS net sales
    // -----------------------------------------------------------------------
    const [catalogItems, allOrders, refunds] = await Promise.all([
      fetchCatalogItems(),
      fetchCompletedOrders(start, end),
      fetchRefunds(start, end),
    ]);

    const posOrders = allOrders.filter(
      (o) => (o.source?.name ?? "") !== "Invoices"
    );

    const result = buildTaproomModelReport(posOrders, catalogItems, refunds);
    let netSalesCents = Object.values(result.byCategory).reduce(
      (sum, cat) => sum + cat.netSalesCents,
      0
    );

    // -----------------------------------------------------------------------
    // 2. Manual entry adjustments
    //
    // Determine grain: if the requested window is ≤ 10 days we treat it as
    // a weekly call and apply each overlapping manual month at 1/4 its value.
    // Otherwise (monthly or longer) we apply the full value.
    // -----------------------------------------------------------------------
    const startDate = new Date(start + "T00:00:00");
    const endDate   = new Date(end   + "T00:00:00");
    const daysDiff  =
      Math.round((endDate.getTime() - startDate.getTime()) / 86_400_000) + 1;
    const isWeekly  = daysDiff <= 10;

    const { data: manualEntries, error: manualErr } = await supabase
      .from("manual_net_sales_entries")
      .select("year, month, amount_cents");
    if (manualErr) throw manualErr;

    for (const entry of manualEntries ?? []) {
      // Month boundaries (local midnight — matches how Achievement builds periods)
      const monthStart = new Date(entry.year, entry.month - 1, 1);
      const monthEnd   = new Date(entry.year, entry.month, 0); // last day
      if (monthStart <= endDate && monthEnd >= startDate) {
        netSalesCents += isWeekly
          ? Math.round(entry.amount_cents / 4)
          : entry.amount_cents;
      }
    }

    return NextResponse.json({ net_sales_cents: netSalesCents, start, end });
  } catch (err) {
    return apiError(err);
  }
}

import { NextRequest, NextResponse } from "next/server";
import { fetchCatalogItems } from "@/lib/square/catalog";
import { fetchCompletedOrders } from "@/lib/square/orders";
import { fetchRefunds } from "@/lib/square/refunds";
import { buildTaproomModelReport } from "@/lib/reports/taproom-model";
import { TAPROOM_MODEL_CATEGORIES } from "@/lib/constants/categories";
import { requireDateRange, apiError } from "@/lib/utils/api";
import { supabase } from "@/lib/supabase/client";

const EXCLUDED_CATEGORY_IDS = new Set(["CO2", "OTHER"]);

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
    let netSalesCents = TAPROOM_MODEL_CATEGORIES.reduce((sum, cat) => {
      if (EXCLUDED_CATEGORY_IDS.has(cat.id)) return sum;
      return sum + (result.byCategory[cat.id]?.netSalesCents ?? 0);
    }, 0);

    // -----------------------------------------------------------------------
    // 2. Manual entry adjustments — prorated by day overlap
    // -----------------------------------------------------------------------
    const startDate = new Date(start + "T00:00:00");
    const endDate   = new Date(end   + "T00:00:00");

    const { data: manualEntries, error: manualErr } = await supabase
      .from("manual_net_sales_entries")
      .select("start_date, end_date, amount_cents");
    if (manualErr) throw manualErr;

    for (const entry of manualEntries ?? []) {
      const entryStart = new Date(entry.start_date + "T00:00:00");
      const entryEnd   = new Date(entry.end_date   + "T00:00:00");

      const overlapStart = startDate > entryStart ? startDate : entryStart;
      const overlapEnd   = endDate   < entryEnd   ? endDate   : entryEnd;

      if (overlapStart <= overlapEnd) {
        const entryDays   = Math.round((entryEnd.getTime()   - entryStart.getTime())   / 86_400_000) + 1;
        const overlapDays = Math.round((overlapEnd.getTime() - overlapStart.getTime()) / 86_400_000) + 1;
        netSalesCents += Math.round(entry.amount_cents * overlapDays / entryDays);
      }
    }

    return NextResponse.json({ net_sales_cents: netSalesCents, start, end });
  } catch (err) {
    return apiError(err);
  }
}

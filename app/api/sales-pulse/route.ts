import { NextRequest, NextResponse } from "next/server";
import { fetchCatalogItems } from "@/lib/square/catalog";
import { fetchCompletedOrders } from "@/lib/square/orders";
import { fetchRefunds } from "@/lib/square/refunds";
import { buildTaproomModelReport } from "@/lib/reports/taproom-model";
import { TAPROOM_MODEL_CATEGORIES } from "@/lib/constants/categories";
import { requireDateRange, apiError } from "@/lib/utils/api";

const EXCLUDED_CATEGORY_IDS = new Set(["CO2", "OTHER"]);

export async function GET(req: NextRequest) {
  const range = requireDateRange(req);
  if (range instanceof NextResponse) return range;
  const { start, end } = range;

  try {
    const [catalogItems, allOrders, refunds] = await Promise.all([
      fetchCatalogItems(),
      fetchCompletedOrders(start, end),
      fetchRefunds(start, end),
    ]);

    const orders = allOrders.filter((o) => (o.source?.name ?? "") !== "Invoices");
    const result = buildTaproomModelReport(orders, catalogItems, refunds);

    // Totals
    let netSalesCents = 0;
    let grossSalesCents = 0;
    for (const cat of TAPROOM_MODEL_CATEGORIES) {
      const t = result.byCategory[cat.id];
      if (!t) continue;
      grossSalesCents += t.grossSalesCents;
      if (!EXCLUDED_CATEGORY_IDS.has(cat.id)) {
        netSalesCents += t.netSalesCents;
      }
    }

    const orderCount = orders.length;
    const avgTicketCents = orderCount > 0 ? Math.round(netSalesCents / orderCount) : 0;

    // Category breakdown
    const byCategory = TAPROOM_MODEL_CATEGORIES.map((cat) => {
      const t = result.byCategory[cat.id];
      return {
        id:                 cat.id,
        label:              cat.label,
        gross_sales_cents:  t?.grossSalesCents  ?? 0,
        discounts_cents:    t?.discountsCents   ?? 0,
        returns_cents:      t?.returnsCents     ?? 0,
        net_sales_cents:    t?.netSalesCents    ?? 0,
        tax_cents:          t?.taxCents         ?? 0,
        excluded:           EXCLUDED_CATEGORY_IDS.has(cat.id),
      };
    });

    // Daily breakdown — group orders and refunds by date, then run the full
    // taproom model report per day so the numbers match the weekly totals exactly.
    const dailyOrderMap = new Map<string, typeof orders>();
    for (const order of orders) {
      const date = (order.closed_at ?? order.created_at ?? "").slice(0, 10);
      if (!dailyOrderMap.has(date)) dailyOrderMap.set(date, []);
      dailyOrderMap.get(date)!.push(order);
    }

    const dailyRefundMap = new Map<string, typeof refunds>();
    for (const refund of refunds) {
      const date = (refund.created_at ?? "").slice(0, 10);
      if (!dailyRefundMap.has(date)) dailyRefundMap.set(date, []);
      dailyRefundMap.get(date)!.push(refund);
    }

    const daily: {
      date: string;
      net_sales_cents: number;
      gross_sales_cents: number;
      order_count: number;
      avg_ticket_cents: number;
    }[] = [];

    const cur     = new Date(start + "T00:00:00");
    const endDate = new Date(end   + "T00:00:00");
    while (cur <= endDate) {
      const dateStr   = cur.toISOString().slice(0, 10);
      const dayOrders = dailyOrderMap.get(dateStr) ?? [];
      const dayRefunds = dailyRefundMap.get(dateStr) ?? [];

      // Run the same report logic used for the weekly totals
      const dayResult = buildTaproomModelReport(dayOrders, catalogItems, dayRefunds);

      let dayNet   = 0;
      let dayGross = 0;
      for (const cat of TAPROOM_MODEL_CATEGORIES) {
        const t = dayResult.byCategory[cat.id];
        if (!t) continue;
        dayGross += t.grossSalesCents;
        if (!EXCLUDED_CATEGORY_IDS.has(cat.id)) {
          dayNet += t.netSalesCents;
        }
      }

      const count = dayOrders.length;
      daily.push({
        date:              dateStr,
        net_sales_cents:   dayNet,
        gross_sales_cents: dayGross,
        order_count:       count,
        avg_ticket_cents:  count > 0 ? Math.round(dayNet / count) : 0,
      });
      cur.setDate(cur.getDate() + 1);
    }

    return NextResponse.json({
      net_sales_cents: netSalesCents,
      gross_sales_cents: grossSalesCents,
      order_count: orderCount,
      avg_ticket_cents: avgTicketCents,
      by_category: byCategory,
      daily,
    });
  } catch (err) {
    return apiError(err);
  }
}

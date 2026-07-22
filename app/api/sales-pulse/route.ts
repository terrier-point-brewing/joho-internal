import { NextRequest, NextResponse } from "next/server";
import { fetchCatalogItems } from "@/lib/square/catalog";
import { fetchCompletedOrders } from "@/lib/square/orders";
import { fetchRefunds } from "@/lib/square/refunds";
import { buildTaproomModelReport } from "@/lib/reports/taproom-model";
import { isInvoiceOrder } from "@/lib/square/invoiceOrders";
import { isReturnOrder } from "@/lib/square/returnOrders";
import { TAPROOM_MODEL_CATEGORIES } from "@/lib/constants/categories";
import { requireDateRange, apiError } from "@/lib/utils/api";
import { localDateString, eachDateString } from "@/lib/utils/datetime";
import { getBreweryTimezone } from "@/lib/settings/breweryTimezone.server";

export const dynamic = "force-dynamic";

const EXCLUDED_CATEGORY_IDS = new Set(["CO2", "OTHER"]);

export async function GET(req: NextRequest) {
  const range = requireDateRange(req);
  if (range instanceof NextResponse) return range;
  const { start, end } = range;

  try {
    const [tz, catalogItems, allOrders, refunds] = await Promise.all([
      getBreweryTimezone(),
      fetchCatalogItems(),
      fetchCompletedOrders(start, end),
      fetchRefunds(start, end),
    ]);

    const orders = allOrders.filter((o) => !isInvoiceOrder(o));
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

    // Guest count counts real sales only. Return orders come back from the
    // COMPLETED search too, but they're the refund's paperwork, not a visit —
    // counting them inflates guests and dilutes average ticket. They stay in
    // `orders` regardless, because the report resolves refunds against them.
    const orderCount = orders.filter((o) => !isReturnOrder(o)).length;
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
    //
    // Bucket on `created_at` (when the order was rung up), NOT `closed_at`. Two
    // reasons: (1) the Square fetch above filters on created_at, so bucketing on
    // any other field can push an order into a local day outside the requested
    // range — the daily rows would then fail to reconcile with the weekly/
    // category totals. (2) A taproom open past midnight settles tabs after 12am;
    // keying on closed_at scatters one business night across two calendar days
    // (e.g. a Sat-night tab paid at 12:30am lands on Sunday). created_at keeps
    // the whole night on the day the sale actually happened.
    const dailyOrderMap = new Map<string, typeof orders>();
    for (const order of orders) {
      const date = localDateString(order.created_at ?? order.closed_at ?? "", tz);
      if (!dailyOrderMap.has(date)) dailyOrderMap.set(date, []);
      dailyOrderMap.get(date)!.push(order);
    }

    const dailyRefundMap = new Map<string, typeof refunds>();
    for (const refund of refunds) {
      const date = localDateString(refund.created_at ?? "", tz);
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

    for (const dateStr of eachDateString(start, end)) {
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

      const count = dayOrders.filter((o) => !isReturnOrder(o)).length;
      daily.push({
        date:              dateStr,
        net_sales_cents:   dayNet,
        gross_sales_cents: dayGross,
        order_count:       count,
        avg_ticket_cents:  count > 0 ? Math.round(dayNet / count) : 0,
      });
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

import { NextRequest, NextResponse } from "next/server";
import { fetchCatalogItems } from "@/lib/square/catalog";
import { fetchCompletedOrders } from "@/lib/square/orders";
import { fetchRefunds } from "@/lib/square/refunds";
import { buildTaproomModelReport } from "@/lib/reports/taproom-model";
import { TAPROOM_MODEL_CATEGORIES } from "@/lib/constants/categories";
import { requireDateRange, apiError } from "@/lib/utils/api";
import { cents } from "@/lib/utils/formatting";

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

    // Taproom Model only counts POS / Square hardware sales.
    // Exclude orders from Invoices (wholesale, contract brewing, etc.).
    const orders = allOrders.filter(
      (o) => (o.source?.name ?? "") !== "Invoices"
    );

    const result = buildTaproomModelReport(orders, catalogItems, refunds);

    const rows = TAPROOM_MODEL_CATEGORIES.map((cat) => {
      const t = result.byCategory[cat.id];
      return {
        category:    cat.label,
        gross_sales: cents(t.grossSalesCents),
        discounts:   cents(t.discountsCents),
        returns:     cents(t.returnsCents),
        net_sales:   cents(t.netSalesCents),
        tax:         cents(t.taxCents),
      };
    });

    return NextResponse.json({
      rows,
      total_tips: cents(result.totalTipsCents),
    });
  } catch (err) {
    return apiError(err);
  }
}

import { NextRequest, NextResponse } from "next/server";
import { fetchCatalogItems } from "@/lib/square/catalog";
import { fetchCompletedOrders } from "@/lib/square/orders";
import { buildKegIndex, detectKegSales } from "@/lib/reports/kegs";
import { requireDateRange, apiError } from "@/lib/utils/api";
import { cents } from "@/lib/utils/formatting";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const range = requireDateRange(req);
  if (range instanceof NextResponse) return range;
  const { start, end } = range;

  try {
    const [catalogItems, orders] = await Promise.all([
      fetchCatalogItems(),
      fetchCompletedOrders(start, end),
    ]);

    const kegIndex = buildKegIndex(catalogItems);
    const sales = detectKegSales(orders, kegIndex);

    const rows = sales.map((s) => {
      const d = new Date(s.orderClosedAt);
      return {
        date:           d.toLocaleDateString("en-US"),
        time:           d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
        beer:           s.beerName,
        size:           s.kegSize,
        qty:            s.quantity,
        is_transfer:    s.isTransfer,
        discount_names: s.discountNames,
        gross_sales:    cents(s.grossSalesCents),
        discounts:      cents(s.discountsCents),
        net_sales:      cents(s.netSalesCents),
        tax:            cents(s.taxCents),
      };
    });

    return NextResponse.json({ rows });
  } catch (err) {
    return apiError(err);
  }
}

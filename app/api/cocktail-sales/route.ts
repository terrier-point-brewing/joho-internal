import { NextRequest, NextResponse } from "next/server";
import { fetchCatalogItems } from "@/lib/square/catalog";
import { fetchCompletedOrders } from "@/lib/square/orders";
import { detectCocktailSales } from "@/lib/reports/cocktails";

function cents(n: number) {
  return (n / 100).toFixed(2);
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const start = searchParams.get("start");
  const end   = searchParams.get("end");
  if (!start || !end) {
    return NextResponse.json({ error: "start and end required" }, { status: 400 });
  }

  try {
    const [catalogItems, orders] = await Promise.all([
      fetchCatalogItems(),
      fetchCompletedOrders(start, end),
    ]);

    const { sales } = detectCocktailSales(orders, catalogItems);

    const rows = sales.map((s) => {
      const d = new Date(s.orderClosedAt);
      return {
        date:        d.toLocaleDateString("en-US"),
        time:        d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
        item:        s.itemName,
        is_combo:    s.isCombo,
        qty:         s.quantity,
        gross_sales: cents(s.grossSalesCents),
        discounts:   cents(s.discountsCents),
        net_sales:   cents(s.netSalesCents),
        tax:         cents(s.taxCents),
      };
    });

    return NextResponse.json({ rows });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

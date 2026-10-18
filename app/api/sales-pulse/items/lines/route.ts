import { NextRequest, NextResponse } from "next/server";
import { fetchCatalogItems } from "@/lib/square/catalog";
import { fetchCompletedOrders } from "@/lib/square/orders";
import { fetchRefunds } from "@/lib/square/refunds";
import { buildTaproomModelReport } from "@/lib/reports/taproom-model";
import { matchesItemKey } from "@/lib/reports/itemSales";
import { isInvoiceOrder } from "@/lib/square/invoiceOrders";
import { requireDateRange, apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

// The individual transactions behind one item on the Items tab:
// `?start&end&item=<itemKey | itemGroupKey>`. Same fetch and filter as the sibling routes,
// filtered server-side to one item so a year of a single SKU is a short list
// rather than every line the taproom rang up.
export async function GET(req: NextRequest) {
  const range = requireDateRange(req);
  if (range instanceof NextResponse) return range;
  const { start, end } = range;
  const item = new URL(req.url).searchParams.get("item");
  if (!item) return NextResponse.json({ error: "item required" }, { status: 400 });

  try {
    const [catalogItems, allOrders, refunds] = await Promise.all([
      fetchCatalogItems(),
      fetchCompletedOrders(start, end),
      fetchRefunds(start, end),
    ]);

    const orders = allOrders.filter((o) => !isInvoiceOrder(o));
    const { contributions } = buildTaproomModelReport(orders, catalogItems, refunds);
    const lines = contributions
      .filter((l) => matchesItemKey(l, item))
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

    return NextResponse.json({ lines });
  } catch (err) {
    return apiError(err);
  }
}

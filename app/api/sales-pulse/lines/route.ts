import { NextRequest, NextResponse } from "next/server";
import { fetchCatalogItems } from "@/lib/square/catalog";
import { fetchCompletedOrders } from "@/lib/square/orders";
import { fetchRefunds } from "@/lib/square/refunds";
import { buildTaproomModelReport } from "@/lib/reports/taproom-model";
import { isInvoiceOrder } from "@/lib/square/invoiceOrders";
import { requireDateRange, apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

// The line-level detail behind the Sales Pulse category breakdown.
//
// Runs the *same* report over the *same* orders as ../route.ts and returns the
// per-line contributions it emitted, so every row here is one of the amounts
// that produced the totals on screen. Two consequences worth preserving:
//
//   1. The order fetch and the invoice filter below must stay identical to the
//      sibling route. If they drift, the drill-down stops reconciling with the
//      table above it.
//   2. Every category comes back in one response, on purpose. Each call costs a
//      full Square round-trip (catalog + orders + refunds), so filtering per
//      category server-side would turn browsing five categories into five slow,
//      rate-limited fetches. The client caches this by date range and filters
//      in memory instead.
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

    const orders = allOrders.filter((o) => !isInvoiceOrder(o));
    const { contributions } = buildTaproomModelReport(orders, catalogItems, refunds);

    return NextResponse.json({ lines: contributions });
  } catch (err) {
    return apiError(err);
  }
}

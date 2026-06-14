import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { fetchCompletedOrders } from "@/lib/square/orders";
import { fetchRefunds } from "@/lib/square/refunds";
import { fetchCatalogItems } from "@/lib/square/catalog";
import type { CatalogItem } from "@/types/square";

export const dynamic = "force-dynamic";

const FL_OZ_PER_POUR = 16;
const FL_OZ_PER_BBL  = 3968;

export async function GET(req: NextRequest) {
  try { await requireRole("admin"); } catch (res) { return res as Response; }

  const year = parseInt(req.nextUrl.searchParams.get("year") ?? String(new Date().getFullYear()));
  const now  = new Date();

  const months: string[] = [];
  for (let m = 1; m <= 12; m++) {
    if (year < now.getFullYear() || m <= now.getMonth() + 1) {
      months.push(`${year}-${String(m).padStart(2, "0")}`);
    }
  }

  const catalogItems: CatalogItem[] = await fetchCatalogItems();

  // Collect all variation IDs that belong to "Event Pours" items
  const eventVariationIds = new Set<string>();
  for (const item of catalogItems) {
    if (item.item_data.name.toLowerCase().includes("event pour")) {
      for (const v of item.item_data.variations ?? []) {
        eventVariationIds.add(v.id);
      }
    }
  }

  const monthResults = await Promise.all(
    months.map(async (ym) => {
      const [y, m] = ym.split("-").map(Number);
      const lastDay = new Date(y, m, 0).getDate();
      const from = `${ym}-01`;
      const to   = `${ym}-${String(lastDay).padStart(2, "0")}`;
      const [orders, refunds] = await Promise.all([
        fetchCompletedOrders(from, to),
        fetchRefunds(from, to),
      ]);
      return { ym, orders, refunds };
    })
  );

  const monthly: Record<string, Record<string, number>> = {};

  for (const { ym, orders, refunds } of monthResults) {
    const posOrders = orders.filter((o) => (o.source?.name ?? "") !== "Invoices");

    let grossCents     = 0;
    let discountsCents = 0;
    let taxCents       = 0;
    let tipsCents      = 0;
    let pourCount      = 0;

    for (const order of posOrders) {
      let orderHasEvent = false;

      for (const li of order.line_items ?? []) {
        if (!eventVariationIds.has(li.catalog_object_id ?? "")) continue;
        const qty = parseFloat(li.quantity ?? "0");
        grossCents     += li.gross_sales_money?.amount ?? 0;
        discountsCents += li.total_discount_money?.amount ?? 0;
        taxCents       += li.total_tax_money?.amount ?? 0;
        pourCount      += qty;
        orderHasEvent   = true;
      }

      if (orderHasEvent) {
        tipsCents += order.total_tip_money?.amount ?? 0;
      }
    }

    // Returns: attribute refunds to orders that contained event pour variations
    const eventOrderIds = new Set(
      posOrders
        .filter((o) => o.line_items?.some((li) => eventVariationIds.has(li.catalog_object_id ?? "")))
        .map((o) => o.id)
    );
    let returnsCents = 0;
    for (const refund of refunds) {
      if (eventOrderIds.has(refund.order_id)) {
        returnsCents += refund.amount_money.amount;
      }
    }

    const grossRevenue   = grossCents / 100;
    const totalDiscounts = discountsCents / 100;
    const totalReturns   = returnsCents / 100;

    monthly[ym] = {
      vol_draft_bbl:   Math.round(((pourCount * FL_OZ_PER_POUR) / FL_OZ_PER_BBL) * 1000) / 1000,
      gross_DRAFT:     grossRevenue,
      gross_revenue:   grossRevenue,
      discounts_DRAFT: totalDiscounts,
      total_discounts: totalDiscounts,
      returns_DRAFT:   totalReturns,
      total_returns:   totalReturns,
      net_sales:       grossRevenue - totalDiscounts - totalReturns,
      tips:            tipsCents / 100,
      tax:             taxCents / 100,
    };
  }

  return NextResponse.json({ year, months, monthly });
}

import { NextRequest, NextResponse } from "next/server";
import { fetchCatalogItems, buildStandalonePriceMap, buildVariationNameMap } from "@/lib/square/catalog";
import { fetchCompletedOrders } from "@/lib/square/orders";
import { buildComboIndex, buildComponentIndex, detectComboSales } from "@/lib/reports/combos";
import type { ComboSale } from "@/types/reports";
import { requireDateRange, apiError } from "@/lib/utils/api";
import { cents } from "@/lib/utils/formatting";

// Multi-component combos (e.g. Citrus Wheat Wave) produce one ComboSale per
// component. Merge them into a single row per (order, combo) by summing money
// fields and taking quantity from the first component seen (all slots have the
// same qty for a given combo sale).
function aggregateByOrderAndCombo(sales: ComboSale[]) {
  const grouped = new Map<string, ComboSale[]>();
  for (const sale of sales) {
    const key = `${sale.orderId}::${sale.comboCatalogItemId}`;
    const group = grouped.get(key) ?? [];
    group.push(sale);
    grouped.set(key, group);
  }

  return Array.from(grouped.values()).map((group) => {
    const first = group[0];
    // Each combo sale produces one component line item per slot.
    // Total component qty / numSlots = number of combos sold.
    const totalComponentQty = group.reduce((s, g) => s + g.quantity, 0);
    const quantity = first.comboNumSlots > 0 ? totalComponentQty / first.comboNumSlots : totalComponentQty;
    return {
      orderId:         first.orderId,
      orderClosedAt:   first.orderClosedAt,
      comboName:       first.comboName,
      quantity,
      grossSalesCents: group.reduce((s, g) => s + g.grossSalesCents, 0),
      discountsCents:  group.reduce((s, g) => s + g.discountsCents, 0),
      netSalesCents:   group.reduce((s, g) => s + g.netSalesCents, 0),
      taxCents:        group.reduce((s, g) => s + g.taxCents, 0),
    };
  });
}

export async function GET(req: NextRequest) {
  const range = requireDateRange(req);
  if (range instanceof NextResponse) return range;
  const { start, end } = range;

  try {
    const [catalogItems, orders] = await Promise.all([
      fetchCatalogItems(),
      fetchCompletedOrders(start, end),
    ]);

    const standalonePrices = buildStandalonePriceMap(catalogItems);
    const variationNames   = buildVariationNameMap(catalogItems);
    const combos           = buildComboIndex(catalogItems);
    const componentIndex   = buildComponentIndex(combos);

    // detectComboSales returns one entry per component line item (preserved for
    // future reports that may need component-level detail).
    const sales = detectComboSales(orders, componentIndex, standalonePrices, variationNames);

    // Collapse multi-component combos into one row per combo per order for display.
    const aggregated = aggregateByOrderAndCombo(sales);

    const rows = aggregated
      .sort((a, b) => b.orderClosedAt.localeCompare(a.orderClosedAt))
      .map((s) => {
        const d = new Date(s.orderClosedAt);
        return {
          date:        d.toLocaleDateString("en-US"),
          time:        d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
          item:        s.comboName,
          qty:         s.quantity,
          gross_sales: cents(s.grossSalesCents),
          discounts:   cents(s.discountsCents),
          net_sales:   cents(s.netSalesCents),
          tax:         cents(s.taxCents),
        };
      });

    return NextResponse.json({ rows });
  } catch (err) {
    return apiError(err);
  }
}

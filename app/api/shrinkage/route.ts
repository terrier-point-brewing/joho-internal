import { NextRequest, NextResponse } from "next/server";
import { fetchCatalogItems } from "@/lib/square/catalog";
import { fetchPhysicalCounts } from "@/lib/square/inventory";
import { buildShrinkageReport } from "@/lib/reports/shrinkage";
import { requireDateRange, apiError } from "@/lib/utils/api";

export async function GET(req: NextRequest) {
  const range = requireDateRange(req);
  if (range instanceof NextResponse) return range;
  const { start, end } = range;

  try {
    const [catalogItems, counts] = await Promise.all([
      fetchCatalogItems(),
      fetchPhysicalCounts(start, end),
    ]);

    const result = buildShrinkageReport(counts, catalogItems);

    const serializeItem = (item: typeof result.draft[0]) => ({
      item_name:         item.itemName,
      variation_name:    item.variationName,
      latest_qty:        item.latestQty.toFixed(1),
      peak_qty:          item.peakQty.toFixed(1),
      pct_remaining:     item.latestPctRemaining !== null ? item.latestPctRemaining.toFixed(1) : null,
      avg_shrinkage_pct: item.avgShrinkagePct    !== null ? item.avgShrinkagePct.toFixed(1)    : null,
      counts: item.counts.map((c) => ({
        date:          c.date,
        week:          c.week,
        qty:           c.qty.toFixed(1),
        shrinkage_pct: c.shrinkagePct !== null ? c.shrinkagePct.toFixed(1) : null,
      })),
    });

    return NextResponse.json({
      draft:       result.draft.map(serializeItem),
      liquor:      result.liquor.map(serializeItem),
      chart_data:  result.chartData,
      chart_items: [
        ...result.draft.map((i) => ({ name: i.itemName, category: "DRAFT" })),
        ...result.liquor.map((i) => ({ name: i.itemName, category: "LIQUOR" })),
      ],
    });
  } catch (err) {
    return apiError(err);
  }
}

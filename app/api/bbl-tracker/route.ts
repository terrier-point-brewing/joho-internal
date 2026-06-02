import { NextRequest, NextResponse } from "next/server";
import { fetchCatalogItems } from "@/lib/square/catalog";
import { fetchCompletedOrders, fetchInvoiceOrders } from "@/lib/square/orders";
import { buildBBLTrackerReport } from "@/lib/reports/bbl-tracker";
import { requireDateRange, apiError } from "@/lib/utils/api";
import { fmt } from "@/lib/utils/formatting";

export async function GET(req: NextRequest) {
  const range = requireDateRange(req);
  if (range instanceof NextResponse) return range;
  const { start, end } = range;

  try {
    const [catalogItems, posOrders, invoiceOrders] = await Promise.all([
      fetchCatalogItems(),
      fetchCompletedOrders(start, end),
      fetchInvoiceOrders(start, end),
    ]);

    const result = buildBBLTrackerReport(posOrders, invoiceOrders, catalogItems);

    return NextResponse.json({
      by_style: result.byStyle.map((r) => ({
        style:             r.style,
        taproom_draft_bbl: fmt(r.taproomDraftBBL),
        taproom_pkg_bbl:   fmt(r.taproomPkgBBL),
        dist_bbl:          fmt(r.distBBL),
        contract_bbl:      fmt(r.contractBBL),
        half_keg_count:    r.halfKegCount,
        quarter_keg_count: r.quarterKegCount,
        sixth_keg_count:   r.sixthKegCount,
        total_cans:        r.totalCans,
        total_bbl:         fmt(r.totalBBL),
        total_gallons:     fmt(r.totalGallons, 2),
        excise_tax:        fmt(r.exciseTax, 2),
      })),
      by_channel: result.byChannel.map((r) => ({
        channel: r.channel,
        bbl:     fmt(r.bbl),
        gallons: fmt(r.gallons, 2),
      })),
      total_excise_tax: fmt(result.totalExciseTax, 2),
    });
  } catch (err) {
    return apiError(err);
  }
}

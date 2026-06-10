import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { fetchCompletedOrders } from "@/lib/square/orders";
import { fetchRefunds } from "@/lib/square/refunds";
import { fetchCatalogItems } from "@/lib/square/catalog";
import { buildTaproomModelReport } from "@/lib/reports/taproom-model";
import { buildKegIndex, detectKegSales } from "@/lib/reports/kegs";
import { canOzPerUnit } from "@/lib/reports/bbl-tracker";
import { TAPROOM_MODEL_CATEGORIES, type TaproomCategoryId, CATEGORY_IDS } from "@/lib/constants/categories";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { CatalogItem } from "@/types/square";

export const dynamic = "force-dynamic";

// Returns month-over-month taproom sales for a given year.
// Each month is fetched in parallel from Square.
export async function GET(req: NextRequest) {
  try { await requireRole("admin"); } catch (res) { return res as Response; }

  const year = parseInt(req.nextUrl.searchParams.get("year") ?? String(new Date().getFullYear()));

  const supabase = await createSupabaseServerClient();
  const now = new Date();

  // Build list of months to fetch (Jan–Dec, capped at current month)
  const months: string[] = [];
  for (let m = 1; m <= 12; m++) {
    if (year < now.getFullYear() || m <= now.getMonth() + 1) {
      months.push(`${year}-${String(m).padStart(2, "0")}`);
    }
  }

  // Draft category IDs (reporting_category.id values for on-tap beer)
  const DRAFT_CATEGORY_IDS = new Set([
    "567KQPEBRBZHG7ATHQFRCRWZ",
    "DCPYMNVDYNX4JAFI22DMVKLN",
  ]);

  /** Parse fl oz from a variation name like "Draft - 16oz" → 16; default 16. */
  function parseFlOz(variationName: string): number {
    const m = variationName.match(/(\d+)\s*oz/i);
    return m ? parseInt(m[1], 10) : 16;
  }

  // BBL per keg size (US standard)
  const KEG_BBL: Record<string, number> = {
    "1/2 Keg": 15.5 / 31,
    "1/4 Keg": 7.75 / 31,
    "1/6 Keg": 5.167 / 31,
  };

  // Fetch catalog once, orders+refunds per month in parallel
  const [catalogItems, ...monthResults] = await Promise.all([
    fetchCatalogItems() as Promise<CatalogItem[]>,
    ...months.map(async (ym) => {
      const [y, m] = ym.split("-").map(Number);
      const lastDay = new Date(y, m, 0).getDate();
      const from = `${ym}-01`;
      const to   = `${ym}-${String(lastDay).padStart(2, "0")}`;
      const [orders, refunds] = await Promise.all([
        fetchCompletedOrders(from, to),
        fetchRefunds(from, to),
      ]);
      return { ym, from, to, orders, refunds };
    }),
  ]);

  // Build keg index (variation_id → KegDefinition)
  const kegIndex = buildKegIndex(catalogItems);

  // Build variation_id → oz-per-unit map for CANS catalog items
  const canVariationOz = new Map<string, number>();
  for (const item of catalogItems) {
    const catId = item.item_data.reporting_category?.id ?? "";
    if (!CATEGORY_IDS.CANS.has(catId)) continue;
    for (const v of item.item_data.variations ?? []) {
      canVariationOz.set(v.id, canOzPerUnit(v.item_variation_data.name));
    }
  }

  // Build variation_id → fl oz map for all draft catalog items
  const draftVariationFlOz = new Map<string, number>();
  for (const item of catalogItems) {
    const catId = item.item_data.reporting_category?.id ?? "";
    if (!DRAFT_CATEGORY_IDS.has(catId)) continue;
    for (const v of item.item_data.variations ?? []) {
      draftVariationFlOz.set(v.id, parseFlOz(v.item_variation_data.name));
    }
  }

  // Fetch manual entries once
  const { data: manualEntries } = await supabase
    .from("manual_net_sales_entries")
    .select("start_date, end_date, amount_cents");

  // Build monthly data
  const monthly: Record<string, Record<string, number>> = {};

  for (const { ym, from, to, orders, refunds } of monthResults) {
    const posOrders = orders.filter((o) => (o.source?.name ?? "") !== "Invoices");
    const report    = buildTaproomModelReport(posOrders, catalogItems, refunds);

    const row: Record<string, number> = {};

    // Revenue, discounts, returns per category
    for (const cat of TAPROOM_MODEL_CATEGORIES) {
      const t = report.byCategory[cat.id];
      row[`gross_${cat.id}`]    = (t?.grossSalesCents  ?? 0) / 100;
      row[`discounts_${cat.id}`]= (t?.discountsCents   ?? 0) / 100;
      row[`returns_${cat.id}`]  = (t?.returnsCents     ?? 0) / 100;
    }

    // Section totals
    row.gross_revenue    = TAPROOM_MODEL_CATEGORIES.reduce((s, c) => s + (report.byCategory[c.id]?.grossSalesCents  ?? 0), 0) / 100;
    row.total_discounts  = TAPROOM_MODEL_CATEGORIES.reduce((s, c) => s + (report.byCategory[c.id]?.discountsCents   ?? 0), 0) / 100;
    row.total_returns    = TAPROOM_MODEL_CATEGORIES.reduce((s, c) => s + (report.byCategory[c.id]?.returnsCents     ?? 0), 0) / 100;

    // Manual entry adjustments prorated to this month
    let manualAdj = 0;
    const startDate = new Date(from + "T00:00:00");
    const endDate   = new Date(to   + "T00:00:00");
    for (const entry of manualEntries ?? []) {
      const eStart  = new Date(entry.start_date + "T00:00:00");
      const eEnd    = new Date(entry.end_date   + "T00:00:00");
      const oStart  = startDate > eStart ? startDate : eStart;
      const oEnd    = endDate   < eEnd   ? endDate   : eEnd;
      if (oStart <= oEnd) {
        const eDays = Math.round((eEnd.getTime()   - eStart.getTime()) / 86_400_000) + 1;
        const oDays = Math.round((oEnd.getTime()   - oStart.getTime()) / 86_400_000) + 1;
        manualAdj  += Math.round(entry.amount_cents * oDays / eDays) / 100;
      }
    }
    row.manual_adjustments = manualAdj;
    row.gross_revenue     += manualAdj;

    row.net_sales = row.gross_revenue - row.total_discounts - row.total_returns;

    // Tips + tax (tax = sum of taxCents per category)
    row.tips = (report.totalTipsCents ?? 0) / 100;
    row.tax  = TAPROOM_MODEL_CATEGORIES.reduce((s, c) => s + (report.byCategory[c.id]?.taxCents ?? 0), 0) / 100;

    // Draft volume — count fl oz sold across all POS line items for draft variations
    let draftFlOz = 0;
    for (const order of posOrders) {
      for (const li of order.line_items ?? []) {
        const flOz = draftVariationFlOz.get(li.catalog_object_id ?? "");
        if (flOz !== undefined) {
          draftFlOz += parseFloat(li.quantity ?? "0") * flOz;
        }
      }
    }
    const draftBbl = Math.round((draftFlOz / 3968) * 1000) / 1000;

    // Keg volume — detect non-transfer keg sales, group by size
    const kegSales = detectKegSales(posOrders, kegIndex).filter((k) => !k.isTransfer);
    let halfKegCount = 0, quarterKegCount = 0, sixthKegCount = 0;
    let kegBbl = 0;
    for (const ks of kegSales) {
      const bblEach = KEG_BBL[ks.kegSize] ?? 0;
      if (ks.kegSize === "1/2 Keg") halfKegCount   += ks.quantity;
      else if (ks.kegSize === "1/4 Keg") quarterKegCount += ks.quantity;
      else if (ks.kegSize === "1/6 Keg") sixthKegCount  += ks.quantity;
      kegBbl += ks.quantity * bblEach;
    }

    // Can volume — count units and convert to BBL via variation oz size
    let canUnits = 0;
    let canBbl   = 0;
    for (const order of posOrders) {
      for (const li of order.line_items ?? []) {
        const oz = canVariationOz.get(li.catalog_object_id ?? "");
        if (oz !== undefined) {
          const qty = parseFloat(li.quantity ?? "0");
          canUnits += qty;
          canBbl   += (qty * oz) / 3968;
        }
      }
    }

    row.vol_draft_bbl   = draftBbl;
    row.vol_half_keg    = halfKegCount;
    row.vol_quarter_keg = quarterKegCount;
    row.vol_sixth_keg   = sixthKegCount;
    row.vol_cans        = canUnits;
    row.total_bbl       = Math.round((draftBbl + kegBbl + canBbl) * 1000) / 1000;

    monthly[ym] = row;
  }

  return NextResponse.json({ year, months, monthly });
}

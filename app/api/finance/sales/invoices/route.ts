import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { fetchInvoiceOrders } from "@/lib/square/orders";
import { fetchCatalogItems } from "@/lib/square/catalog";
import { buildKegIndex } from "@/lib/reports/kegs";
import { canOzPerUnit } from "@/lib/reports/bbl-tracker";
import { CATEGORY_IDS } from "@/lib/constants/categories";
import { apiError } from "@/lib/utils/api";
import type { CatalogItem } from "@/types/square";

export const dynamic = "force-dynamic";

// Volume / excise constants
const KEG_BBL: Record<string, number> = {
  "1/2 Keg": 15.5 / 31,
  "1/4 Keg": 7.75 / 31,
  "1/6 Keg": 5.167 / 31,
};
// NC barrel excise: $0.6171 / gallon × 31 gal/BBL
const NC_EXCISE_PER_BBL  = 31 * 0.6171;
const FED_EXCISE_PER_BBL = 3.50;

// ---------------------------------------------------------------------------
// Line-item classifiers
// ---------------------------------------------------------------------------

type CBSubcat = "materials_packaging" | "packaging_fees" | "other_services";

function classifyCB(name: string): CBSubcat | null {
  const n = name.toLowerCase();
  if (n.includes("ingredient deposit") || n.includes("packaging material")) return "materials_packaging";
  // "packaging fee" is handled separately (needs volume extraction from variation name)
  if (
    n.includes("keg cleaning") ||
    n.includes("forklift")     ||
    n.includes("keg transformation") ||
    n.includes("co2 refill")
  ) return "other_services";
  return null;
}

function isBET(name: string) {
  return name.toLowerCase().includes("barrel excise tax");
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  try { await requireRole("admin"); } catch (res) { return res as Response; }

  try {
  const year = parseInt(req.nextUrl.searchParams.get("year") ?? String(new Date().getFullYear()));
  const now  = new Date();

  const months: string[] = [];
  for (let m = 1; m <= 12; m++) {
    if (year < now.getFullYear() || m <= now.getMonth() + 1) {
      months.push(`${year}-${String(m).padStart(2, "0")}`);
    }
  }

  // Fetch catalog + all months in parallel
  const [catalogItems, ...monthResults] = await Promise.all([
    fetchCatalogItems() as Promise<CatalogItem[]>,
    ...months.map(async (ym) => {
      const [y, m] = ym.split("-").map(Number);
      const lastDay = new Date(y, m, 0).getDate();
      const orders  = await fetchInvoiceOrders(`${ym}-01`, `${ym}-${String(lastDay).padStart(2, "0")}`);
      return { ym, orders };
    }),
  ]);

  // Catalog indexes
  const kegIndex = buildKegIndex(catalogItems);

  const canVariationOz = new Map<string, number>();
  for (const item of catalogItems) {
    if (!CATEGORY_IDS.CANS.has(item.item_data.reporting_category?.id ?? "")) continue;
    for (const v of item.item_data.variations ?? []) {
      canVariationOz.set(v.id, canOzPerUnit(v.item_variation_data.name));
    }
  }

  const cbMonthly:   Record<string, Record<string, number>> = {};
  const distMonthly: Record<string, Record<string, number>> = {};

  for (const { ym, orders } of monthResults) {
    const cb: Record<string, number> = {
      materials_packaging: 0, packaging_fees: 0, other_services: 0, pass_through_taxes: 0,
      gross_revenue: 0,
      discounts: 0, remits: 0, deduct_pass_through: 0, total_deductions: 0,
      net_sales: 0,
      vol_half_keg: 0, vol_quarter_keg: 0, vol_sixth_keg: 0, vol_cans: 0, total_bbl: 0,
      excise_tax_nc: 0, excise_tax_federal: 0,
    };
    const dist: Record<string, number> = {
      rev_half_keg: 0, rev_quarter_keg: 0, rev_sixth_keg: 0, rev_cans: 0,
      gross_revenue: 0,
      discounts: 0, remits: 0, total_deductions: 0,
      net_sales: 0,
      vol_half_keg: 0, vol_quarter_keg: 0, vol_sixth_keg: 0, vol_cans: 0, total_bbl: 0,
      excise_tax_nc: 0, excise_tax_federal: 0,
    };

    for (const order of orders) {
      // BET carve-out detection: a true carve-out has an ORDER-level discount
      // whose name contains "carve out". Collect their amounts so we can match
      // them to specific BET line items by amount (within 1 cent tolerance).
      const carveOutAmounts = (order.discounts ?? [])
        .filter((d) => d.name.toLowerCase().includes("carve out"))
        .map((d) => d.applied_money?.amount ?? 0)
        .filter((a) => a > 0);

      for (const li of order.line_items ?? []) {
        const qty        = parseFloat(li.quantity ?? "1");
        const grossCents = li.gross_sales_money?.amount ?? 0;
        const discCents  = li.total_discount_money?.amount ?? 0;
        const varId      = li.catalog_object_id ?? "";
        const varName    = li.variation_name ?? "";

        // ── Distribution: keg items (catalog, preset price) ─────────────
        const keg = kegIndex.get(varId);
        if (keg) {
          const bbl = qty * (KEG_BBL[keg.kegSize] ?? 0);
          if      (keg.kegSize === "1/2 Keg") { dist.rev_half_keg    += grossCents / 100; dist.vol_half_keg    += qty; }
          else if (keg.kegSize === "1/4 Keg") { dist.rev_quarter_keg += grossCents / 100; dist.vol_quarter_keg += qty; }
          else if (keg.kegSize === "1/6 Keg") { dist.rev_sixth_keg   += grossCents / 100; dist.vol_sixth_keg   += qty; }
          dist.gross_revenue += grossCents / 100;
          dist.discounts     += discCents  / 100;
          dist.total_bbl     += bbl;
          continue;
        }

        // ── Distribution: can items (catalog, preset price) ─────────────
        const ozPerUnit = canVariationOz.get(varId);
        if (ozPerUnit !== undefined) {
          const bbl = (qty * ozPerUnit) / 3968;
          dist.rev_cans      += grossCents / 100;
          dist.vol_cans      += qty;
          dist.gross_revenue += grossCents / 100;
          dist.discounts     += discCents  / 100;
          dist.total_bbl     += bbl;
          continue;
        }

        // ── Contract Brewing: Barrel Excise Tax ─────────────────────────
        if (isBET(li.name)) {
          // True carve-out = order has a "carve out" discount matching this BET amount
          const carveIdx = carveOutAmounts.findIndex((a) => Math.abs(a - grossCents) <= 1);
          if (carveIdx >= 0) {
            carveOutAmounts.splice(carveIdx, 1); // consume this carve-out match
            continue;                            // skip — nets to zero
          }
          // Otherwise it's a CB pass-through (charge client + remit = no net impact)
          cb.pass_through_taxes  += grossCents / 100;
          cb.gross_revenue       += grossCents / 100;
          cb.deduct_pass_through += grossCents / 100;
          continue;
        }

        // ── Contract Brewing: Packaging Fee volume attribution ───────────
        // Packaging Fee variation names encode keg size or can format.
        // Use these to build CB volume (separate from revenue classification).
        if (li.name.toLowerCase().includes("packaging fee")) {
          if      (varName === "1/2 Keg") { cb.vol_half_keg    += qty; cb.total_bbl += qty * (KEG_BBL["1/2 Keg"] ?? 0); }
          else if (varName === "1/4 Keg") { cb.vol_quarter_keg += qty; cb.total_bbl += qty * (KEG_BBL["1/4 Keg"] ?? 0); }
          else if (varName === "1/6 Keg") { cb.vol_sixth_keg   += qty; cb.total_bbl += qty * (KEG_BBL["1/6 Keg"] ?? 0); }
          else if (varName)               { // can format: "16oz Case", "16oz Can", etc.
            const ozEach = canOzPerUnit(varName);
            cb.vol_cans  += qty;
            cb.total_bbl += (qty * ozEach) / 3968;
          }
          // Also classify as packaging_fees revenue
          cb.packaging_fees += grossCents / 100;
          cb.gross_revenue  += grossCents / 100;
          cb.discounts      += discCents  / 100;
          continue;
        }

        // ── Contract Brewing: other service items ────────────────────────
        const cbCat = classifyCB(li.name);
        if (cbCat) {
          cb[cbCat]        += grossCents / 100;
          cb.gross_revenue += grossCents / 100;
          cb.discounts     += discCents  / 100;
        }
      }
    }

    // Totals & derived stats
    cb.total_deductions   = cb.discounts + cb.remits + cb.deduct_pass_through;
    cb.net_sales          = cb.gross_revenue - cb.total_deductions;
    cb.excise_tax_nc      = Math.round(cb.total_bbl * NC_EXCISE_PER_BBL  * 100) / 100;
    cb.excise_tax_federal = Math.round(cb.total_bbl * FED_EXCISE_PER_BBL * 100) / 100;

    dist.total_deductions   = dist.discounts + dist.remits;
    dist.net_sales          = dist.gross_revenue - dist.total_deductions;
    dist.excise_tax_nc      = Math.round(dist.total_bbl * NC_EXCISE_PER_BBL  * 100) / 100;
    dist.excise_tax_federal = Math.round(dist.total_bbl * FED_EXCISE_PER_BBL * 100) / 100;

    cbMonthly[ym]   = cb;
    distMonthly[ym] = dist;
  }

  return NextResponse.json({ year, months, contractBrewing: cbMonthly, distribution: distMonthly });
  } catch (err) {
    return apiError(err);
  }
}

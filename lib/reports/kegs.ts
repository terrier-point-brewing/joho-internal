import type { CatalogItem, Order } from "@/types/square";
import type { KegSale } from "@/types/reports";
import { KEG_TRANSFER_DISCOUNT_NAME } from "@/types/reports";
import { CATEGORY_IDS } from "@/lib/constants/categories";
import { mapDiscountsByUid } from "@/lib/utils/orders";
const KEG_CATEGORY_IDS = CATEGORY_IDS.KEGS;

// Keg sizes as they appear in variation names — used to exclude deposits
// (which use "Regular") from the keg index.
const KEG_SIZE_PATTERN = /^\d+\/\d+ Keg$/;

export interface KegDefinition {
  catalogItemId: string;
  variationId: string;
  beerName: string; // item name with " (Keg)" stripped
  kegSize: string;  // "1/6 Keg" | "1/4 Keg" | "1/2 Keg"
}

// Build a map of variation_id → KegDefinition for all keg items.
export function buildKegIndex(items: CatalogItem[]): Map<string, KegDefinition> {
  const index = new Map<string, KegDefinition>();

  for (const item of items) {
    const d = item.item_data;
    const categoryId = d.reporting_category?.id ?? "";
    if (!KEG_CATEGORY_IDS.has(categoryId)) continue;

    for (const v of d.variations ?? []) {
      const kegSize = v.item_variation_data.name;
      if (!KEG_SIZE_PATTERN.test(kegSize)) continue; // skip deposits

      index.set(v.id, {
        catalogItemId: item.id,
        variationId: v.id,
        beerName: d.name.replace(/ \(Keg\)$/i, ""),
        kegSize,
      });
    }
  }

  return index;
}

// Scan orders and return one KegSale per keg line item.
// Transfers are included but flagged with isTransfer=true so the caller
// can handle them separately (display in a dedicated column, exclude from totals).
export function detectKegSales(
  orders: Order[],
  kegIndex: Map<string, KegDefinition>
): KegSale[] {
  const sales: KegSale[] = [];

  for (const order of orders) {
    const discountByUid = mapDiscountsByUid(order);

    for (const line of order.line_items ?? []) {
      const varId = line.catalog_object_id;
      if (!varId) continue;

      const keg = kegIndex.get(varId);
      if (!keg) continue;

      const discountNames = (line.applied_discounts ?? [])
        .map((ad) => discountByUid.get(ad.discount_uid) ?? "Unknown Discount")
        .filter(Boolean);

      const isTransfer = discountNames.includes(KEG_TRANSFER_DISCOUNT_NAME);

      const qty = parseInt(line.quantity ?? "1", 10);
      const gross = line.gross_sales_money?.amount ?? 0;
      const discounts = line.total_discount_money?.amount ?? 0;
      const tax = line.total_tax_money?.amount ?? 0;

      sales.push({
        orderId: order.id,
        orderClosedAt: order.closed_at ?? order.created_at,

        beerName: keg.beerName,
        kegSize: keg.kegSize,
        catalogItemId: keg.catalogItemId,
        variationId: keg.variationId,

        isTransfer,
        discountNames,

        quantity: qty,
        grossSalesCents: gross,
        discountsCents: discounts,
        netSalesCents: gross - discounts,
        taxCents: tax,

        rawOrder: order,
        rawLineItem: line,
      });
    }
  }

  return sales.sort((a, b) => b.orderClosedAt.localeCompare(a.orderClosedAt));
}

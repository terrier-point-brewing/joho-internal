/**
 * Unified cocktail detection — covers two sources:
 *
 * 1. COMBO cocktails: items with product_type=COMBO in the Cocktails category.
 *    Detected by comparing the component line item's charged price against its
 *    standalone catalog price (the combo's fixed price overrides it).
 *
 * 2. Non-combo cocktails: items with product_type=FOOD_AND_BEV (or other) in
 *    the Cocktails category. Detected directly by catalog_object_id.
 *
 * Both sources are returned as CocktailSale[]. Callers that need to avoid
 * double-counting in aggregate reports should use `claimedLineItemKeys` to
 * skip combo component line items during category-level sweeps.
 */

import type { CatalogItem, Order } from "@/types/square";
import type { CocktailSale } from "@/types/reports";
import { CATEGORY_IDS } from "@/lib/constants/categories";
import {
  buildComboIndex,
  buildComponentIndex,
  detectComboSales,
  type ComboDefinition,
} from "./combos";
import { buildStandalonePriceMap, buildVariationNameMap } from "@/lib/square/catalog";
import { memoizeByRef } from "@/lib/utils/memo";

export { buildComboIndex, buildComponentIndex, type ComboDefinition };

// Build a set of variation IDs for non-COMBO items in the Cocktails category.
// Memoized by item-array reference (see memoizeByRef).
export const buildNonComboCocktailVariationIds = memoizeByRef((items: CatalogItem[]): Set<string> => {
  const ids = new Set<string>();
  for (const item of items) {
    const catId = item.item_data.reporting_category?.id ?? "";
    if (!CATEGORY_IDS.COCKTAILS.has(catId)) continue;
    if (item.item_data.product_type === "COMBO") continue; // handled separately
    for (const v of item.item_data.variations ?? []) {
      ids.add(v.id);
    }
  }
  return ids;
});

export interface CocktailDetectionResult {
  sales: CocktailSale[];
  // "orderId:lineItemUid" for every line item consumed by combo detection.
  // Used by the Taproom Model to exclude these from the category sweep so
  // combo components aren't double-counted under Liquor / Draft Beer.
  comboClaimedKeys: Set<string>;
}

export function detectCocktailSales(
  orders: Order[],
  items: CatalogItem[]
): CocktailDetectionResult {
  const standalonePrices = buildStandalonePriceMap(items);
  const variationNames   = buildVariationNameMap(items);
  const comboDefs        = buildComboIndex(items);
  const componentIndex   = buildComponentIndex(comboDefs);
  const nonComboIds      = buildNonComboCocktailVariationIds(items);

  // ── 1. Combo cocktails ──────────────────────────────────────────────────
  const rawComboSales = detectComboSales(
    orders, componentIndex, standalonePrices, variationNames
  );

  // Aggregate multi-component combos into one sale per (order, combo item).
  const comboGroups = new Map<string, typeof rawComboSales>();
  for (const cs of rawComboSales) {
    const key = `${cs.orderId}::${cs.comboCatalogItemId}`;
    const g = comboGroups.get(key) ?? [];
    g.push(cs);
    comboGroups.set(key, g);
  }

  const comboClaimedKeys = new Set<string>();
  const cocktailSales: CocktailSale[] = [];

  for (const group of comboGroups.values()) {
    const first = group[0];
    const totalComponentQty = group.reduce((s, g) => s + g.quantity, 0);
    const qty = first.comboNumSlots > 0
      ? totalComponentQty / first.comboNumSlots
      : totalComponentQty;

    for (const cs of group) {
      comboClaimedKeys.add(`${cs.orderId}:${cs.rawLineItem.uid}`);
    }

    cocktailSales.push({
      orderId:        first.orderId,
      orderClosedAt:  first.orderClosedAt,
      itemName:       first.comboName,
      variationName:  "",
      isCombo:        true,
      quantity:       qty,
      grossSalesCents:   group.reduce((s, g) => s + g.grossSalesCents,  0),
      discountsCents:    group.reduce((s, g) => s + g.discountsCents,   0),
      netSalesCents:     group.reduce((s, g) => s + g.netSalesCents,    0),
      taxCents:          group.reduce((s, g) => s + g.taxCents,         0),
      rawOrder:       first.rawOrder,
      rawLineItems:   group.map((g) => g.rawLineItem),
    });
  }

  // ── 2. Non-combo cocktails ───────────────────────────────────────────────
  for (const order of orders) {
    for (const line of order.line_items ?? []) {
      const varId = line.catalog_object_id;
      if (!varId || !nonComboIds.has(varId)) continue;

      const qty      = parseInt(line.quantity ?? "1", 10);
      const gross    = line.gross_sales_money?.amount ?? 0;
      const discounts = line.total_discount_money?.amount ?? 0;
      const tax      = line.total_tax_money?.amount ?? 0;
      const names    = variationNames.get(varId);

      cocktailSales.push({
        orderId:       order.id,
        orderClosedAt: order.closed_at ?? order.created_at,
        itemName:      names?.itemName ?? line.name,
        variationName: names?.variationName ?? line.variation_name ?? "",
        isCombo:       false,
        quantity:      qty,
        grossSalesCents:  gross,
        discountsCents:   discounts,
        netSalesCents:    gross - discounts,
        taxCents:         tax,
        rawOrder:      order,
        rawLineItems:  [line],
      });
    }
  }

  cocktailSales.sort((a, b) => b.orderClosedAt.localeCompare(a.orderClosedAt));
  return { sales: cocktailSales, comboClaimedKeys };
}

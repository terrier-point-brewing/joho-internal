import type { CatalogItem } from "@/types/square";
import type { Order } from "@/types/square";
import type { ComboSale } from "@/types/reports";

// Reporting category IDs for Cocktails (both locations share the same set).
const COCKTAIL_CATEGORY_IDS = new Set([
  "IPD6T7FOCCZBXG2HOPOVFB4J",
  "UE65PMYDYAA3GZVZZE2QXTEF",
]);

// Describes a single combo item and all its component slots for detection.
export interface ComboDefinition {
  catalogItemId: string;
  variationId: string;
  name: string;
  categoryId: string;
  priceCents: number;
  // Number of required slots (each slot requires exactly 1 selection)
  numSlots: number;
  // All variation IDs that can appear as a component of this combo
  componentVariationIds: Set<string>;
}

// Build the index of cocktail combos from catalog items.
// Returns only COMBO items whose reporting_category is a Cocktails category.
export function buildComboIndex(items: CatalogItem[]): ComboDefinition[] {
  const combos: ComboDefinition[] = [];

  for (const item of items) {
    const d = item.item_data;
    if (d.product_type !== "COMBO") continue;

    const categoryId = d.reporting_category?.id ?? "";
    if (!COCKTAIL_CATEGORY_IDS.has(categoryId)) continue;

    const variation = d.variations?.[0];
    if (!variation) continue;

    const priceCents = variation.item_variation_data.price_money?.amount;
    if (priceCents === undefined) continue;

    const componentVariationIds = new Set<string>();
    for (const slot of d.combo_type_details?.slots ?? []) {
      for (const vid of slot.item_variation_ids) {
        componentVariationIds.add(vid);
      }
    }

    const slots = d.combo_type_details?.slots ?? [];
    combos.push({
      catalogItemId: item.id,
      variationId: variation.id,
      name: d.name,
      categoryId,
      priceCents,
      numSlots: slots.length,
      componentVariationIds,
    });
  }

  return combos;
}

// Index structure used during detection: component variation ID → combo definition.
// A component variation ID should only belong to one cocktail combo.
type ComponentIndex = Map<string, ComboDefinition>;

export function buildComponentIndex(combos: ComboDefinition[]): ComponentIndex {
  const index: ComponentIndex = new Map();
  for (const combo of combos) {
    for (const vid of combo.componentVariationIds) {
      index.set(vid, combo);
    }
  }
  return index;
}

// Core detection: scan orders and return one ComboSale per combo component line item
// whose charged price differs from its standalone catalog price (the combo signal).
export function detectComboSales(
  orders: Order[],
  componentIndex: ComponentIndex,
  standalonePrices: Map<string, number>,
  variationNames: Map<string, { itemName: string; variationName: string; itemId: string }>
): ComboSale[] {
  const sales: ComboSale[] = [];

  for (const order of orders) {
    for (const line of order.line_items ?? []) {
      const varId = line.catalog_object_id;
      if (!varId) continue;

      const combo = componentIndex.get(varId);
      if (!combo) continue;

      const standalonePrice = standalonePrices.get(varId);
      if (standalonePrice === undefined) continue;

      const pricedAt = line.base_price_money?.amount ?? 0;

      // Combo signal: the component was charged at a price different from its
      // standalone catalog price (the combo's fixed price overrides it).
      if (pricedAt === standalonePrice) continue;

      const qty = parseInt(line.quantity ?? "1", 10);
      const gross = line.gross_sales_money?.amount ?? pricedAt * qty;
      const discounts = line.total_discount_money?.amount ?? 0;
      const tax = line.total_tax_money?.amount ?? 0;
      const names = variationNames.get(varId);

      sales.push({
        orderId: order.id,
        orderClosedAt: order.closed_at ?? order.created_at,

        comboName: combo.name,
        comboCategoryId: combo.categoryId,
        comboCatalogItemId: combo.catalogItemId,
        comboVariationId: combo.variationId,
        comboPriceCents: combo.priceCents,

        componentVariationId: varId,
        componentName: names?.itemName ?? line.name,
        componentVariationName: names?.variationName ?? line.variation_name ?? "",
        componentStandalonePriceCents: standalonePrice,
        pricedAtCents: pricedAt,

        quantity: qty,
        comboNumSlots: combo.numSlots,
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

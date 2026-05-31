import { squareGetAll } from "./client";
import type { CatalogObject, CatalogItem, CatalogItemVariation } from "@/types/square";

// Returns every ITEM object from the catalog (single paginated call).
export async function fetchCatalogItems(): Promise<CatalogItem[]> {
  const objects = await squareGetAll<CatalogObject>("/catalog/list", "objects", { types: "ITEM" });
  return objects.filter((o): o is CatalogItem => o.type === "ITEM");
}

// Standalone price lookup: variation_id → price in cents.
// Built from ALL catalog items so combo component lookup works.
export function buildStandalonePriceMap(items: CatalogItem[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items) {
    for (const v of item.item_data.variations ?? []) {
      const price = v.item_variation_data.price_money?.amount;
      if (price !== undefined) map.set(v.id, price);
    }
  }
  return map;
}

// Variation name lookup: variation_id → { itemName, variationName, itemId }
export function buildVariationNameMap(
  items: CatalogItem[]
): Map<string, { itemName: string; variationName: string; itemId: string }> {
  const map = new Map<string, { itemName: string; variationName: string; itemId: string }>();
  for (const item of items) {
    for (const v of item.item_data.variations ?? []) {
      map.set(v.id, {
        itemName: item.item_data.name,
        variationName: v.item_variation_data.name,
        itemId: item.id,
      });
    }
  }
  return map;
}

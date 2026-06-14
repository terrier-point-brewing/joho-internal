import { unstable_cache } from "next/cache";
import { squareGetAll } from "./client";
import { memoizeByRef } from "@/lib/utils/memo";
import type { CatalogObject, CatalogItem, CatalogCategory, CatalogTax } from "@/types/square";

// Returns every ITEM object from the catalog (single paginated call).
async function fetchCatalogItemsUncached(): Promise<CatalogItem[]> {
  const objects = await squareGetAll<CatalogObject>("/catalog/list", "objects", { types: "ITEM" });
  return objects.filter((o): o is CatalogItem => o.type === "ITEM");
}

// The full catalog changes infrequently but is fetched by every report route.
// Cache it cross-request (5 min) so a burst of reports hits Square once, not
// once per report. Bust via revalidateTag("square-catalog") after a sync.
export const fetchCatalogItems = unstable_cache(
  fetchCatalogItemsUncached,
  ["square-catalog-items"],
  { revalidate: 300, tags: ["square-catalog"] },
);

async function fetchCatalogCategoriesUncached(): Promise<CatalogCategory[]> {
  const objects = await squareGetAll<CatalogObject>("/catalog/list", "objects", { types: "CATEGORY" });
  return objects.filter((o): o is CatalogCategory => o.type === "CATEGORY");
}

export const fetchCatalogCategories = unstable_cache(
  fetchCatalogCategoriesUncached,
  ["square-catalog-categories"],
  { revalidate: 300, tags: ["square-catalog"] },
);

async function fetchCatalogTaxesUncached(): Promise<CatalogTax[]> {
  const objects = await squareGetAll<CatalogObject>("/catalog/list", "objects", { types: "TAX" });
  return objects.filter((o): o is CatalogTax => o.type === "TAX");
}

export const fetchCatalogTaxes = unstable_cache(
  fetchCatalogTaxesUncached,
  ["square-catalog-taxes"],
  { revalidate: 300, tags: ["square-catalog"] },
);

// Standalone price lookup: variation_id → price in cents.
// Built from ALL catalog items so combo component lookup works.
// Memoized by item-array reference (see memoizeByRef).
export const buildStandalonePriceMap = memoizeByRef((items: CatalogItem[]): Map<string, number> => {
  const map = new Map<string, number>();
  for (const item of items) {
    for (const v of item.item_data.variations ?? []) {
      const price = v.item_variation_data.price_money?.amount;
      if (price !== undefined) map.set(v.id, price);
    }
  }
  return map;
});

// Variation name lookup: variation_id → { itemName, variationName, itemId }
export const buildVariationNameMap = memoizeByRef(
  (items: CatalogItem[]): Map<string, { itemName: string; variationName: string; itemId: string }> => {
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
  },
);

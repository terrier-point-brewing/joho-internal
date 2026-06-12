import { unstable_cache } from "next/cache";
import { squareGetAll } from "./client";
import { memoizeByRef } from "@/lib/utils/memo";
import type { CatalogObject, CatalogItem } from "@/types/square";

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

// In-process cache for the Ingredient Deposit catalog variation ID.
// Avoids a catalog fetch on every invoice generation while still recovering
// automatically if the cache is cold (new process / cold start).
let _depositVariationId: string | null | undefined = undefined;

/**
 * Returns the Square catalog variation ID for the "Ingredient Deposit" item.
 * Checks SQUARE_INGREDIENT_DEPOSIT_VARIATION_ID env var first; falls back to
 * a case-insensitive catalog name search and caches the result in-process.
 */
export async function findIngredientDepositVariationId(): Promise<string | null> {
  const envId = process.env.SQUARE_INGREDIENT_DEPOSIT_VARIATION_ID;
  if (envId) return envId;

  if (_depositVariationId !== undefined) return _depositVariationId;

  const items = await fetchCatalogItems();
  const match = items.find((item) =>
    item.item_data.name.toLowerCase().includes("ingredient deposit")
  );

  _depositVariationId =
    match && match.item_data.variations.length > 0
      ? match.item_data.variations[0].id
      : null;

  return _depositVariationId;
}

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

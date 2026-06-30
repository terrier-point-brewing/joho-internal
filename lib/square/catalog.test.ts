import { describe, it, expect } from "vitest";
import { buildStandalonePriceMap, buildVariationNameMap } from "./catalog";
import type { CatalogItem, CatalogItemVariation } from "@/types/square";

function variation(p: Partial<CatalogItemVariation> & { id: string }): CatalogItemVariation {
  return {
    type: "ITEM_VARIATION",
    id: p.id,
    item_variation_data: {
      item_id: "item",
      name: "Regular",
      ...p.item_variation_data,
    },
  };
}

function item(p: {
  id: string;
  name: string;
  variations: CatalogItemVariation[];
}): CatalogItem {
  return {
    type: "ITEM",
    id: p.id,
    item_data: {
      name: p.name,
      product_type: "REGULAR",
      variations: p.variations,
    },
  };
}

describe("buildStandalonePriceMap", () => {
  it("maps each variation id to its price in cents", () => {
    const items = [
      item({
        id: "i1",
        name: "IPA",
        variations: [
          variation({ id: "v1", item_variation_data: { item_id: "i1", name: "16oz", price_money: { amount: 800, currency: "USD" } } }),
          variation({ id: "v2", item_variation_data: { item_id: "i1", name: "12oz", price_money: { amount: 600, currency: "USD" } } }),
        ],
      }),
    ];
    const map = buildStandalonePriceMap(items);
    expect(map.get("v1")).toBe(800);
    expect(map.get("v2")).toBe(600);
  });

  it("includes prices across multiple items (for combo component lookup)", () => {
    const items = [
      item({ id: "i1", name: "IPA", variations: [variation({ id: "v1", item_variation_data: { item_id: "i1", name: "a", price_money: { amount: 100, currency: "USD" } } })] }),
      item({ id: "i2", name: "Stout", variations: [variation({ id: "v2", item_variation_data: { item_id: "i2", name: "b", price_money: { amount: 200, currency: "USD" } } })] }),
    ];
    const map = buildStandalonePriceMap(items);
    expect(map.size).toBe(2);
    expect(map.get("v1")).toBe(100);
    expect(map.get("v2")).toBe(200);
  });

  it("skips variations with no price_money", () => {
    const items = [
      item({
        id: "i1",
        name: "IPA",
        variations: [
          variation({ id: "priced", item_variation_data: { item_id: "i1", name: "a", price_money: { amount: 500, currency: "USD" } } }),
          variation({ id: "unpriced", item_variation_data: { item_id: "i1", name: "b" } }),
        ],
      }),
    ];
    const map = buildStandalonePriceMap(items);
    expect(map.has("priced")).toBe(true);
    expect(map.has("unpriced")).toBe(false);
  });

  it("preserves a zero-cent price (free item) — not treated as missing", () => {
    const items = [
      item({ id: "i1", name: "Sample", variations: [variation({ id: "free", item_variation_data: { item_id: "i1", name: "a", price_money: { amount: 0, currency: "USD" } } })] }),
    ];
    const map = buildStandalonePriceMap(items);
    expect(map.get("free")).toBe(0);
  });

  it("tolerates an item with an undefined variations array", () => {
    const broken = { type: "ITEM", id: "i1", item_data: { name: "x", product_type: "REGULAR" } } as unknown as CatalogItem;
    const map = buildStandalonePriceMap([broken]);
    expect(map.size).toBe(0);
  });

  it("returns an empty map for an empty item list", () => {
    expect(buildStandalonePriceMap([]).size).toBe(0);
  });

  it("memoizes by array reference (same reference returns same Map instance)", () => {
    const items = [item({ id: "i1", name: "IPA", variations: [variation({ id: "v1", item_variation_data: { item_id: "i1", name: "a", price_money: { amount: 100, currency: "USD" } } })] })];
    const first = buildStandalonePriceMap(items);
    const second = buildStandalonePriceMap(items);
    expect(second).toBe(first);
  });

  it("rebuilds for a different array reference", () => {
    const a = [item({ id: "i1", name: "IPA", variations: [variation({ id: "v1", item_variation_data: { item_id: "i1", name: "a", price_money: { amount: 100, currency: "USD" } } })] })];
    const b = [item({ id: "i2", name: "Stout", variations: [variation({ id: "v2", item_variation_data: { item_id: "i2", name: "b", price_money: { amount: 200, currency: "USD" } } })] })];
    expect(buildStandalonePriceMap(a)).not.toBe(buildStandalonePriceMap(b));
  });
});

describe("buildVariationNameMap", () => {
  it("maps variation id to item name, variation name, and item id", () => {
    const items = [
      item({
        id: "i1",
        name: "Hazy IPA",
        variations: [variation({ id: "v1", item_variation_data: { item_id: "i1", name: "16oz Draft" } })],
      }),
    ];
    const map = buildVariationNameMap(items);
    expect(map.get("v1")).toEqual({ itemName: "Hazy IPA", variationName: "16oz Draft", itemId: "i1" });
  });

  it("includes a variation even when it has no price (name map is price-independent)", () => {
    const items = [
      item({ id: "i1", name: "IPA", variations: [variation({ id: "v1", item_variation_data: { item_id: "i1", name: "Regular" } })] }),
    ];
    const map = buildVariationNameMap(items);
    expect(map.get("v1")?.variationName).toBe("Regular");
  });

  it("maps variations across multiple items", () => {
    const items = [
      item({ id: "i1", name: "IPA", variations: [variation({ id: "v1", item_variation_data: { item_id: "i1", name: "a" } })] }),
      item({ id: "i2", name: "Stout", variations: [variation({ id: "v2", item_variation_data: { item_id: "i2", name: "b" } })] }),
    ];
    const map = buildVariationNameMap(items);
    expect(map.get("v1")?.itemName).toBe("IPA");
    expect(map.get("v2")?.itemName).toBe("Stout");
  });

  it("tolerates an item with an undefined variations array", () => {
    const broken = { type: "ITEM", id: "i1", item_data: { name: "x", product_type: "REGULAR" } } as unknown as CatalogItem;
    expect(buildVariationNameMap([broken]).size).toBe(0);
  });

  it("returns an empty map for an empty item list", () => {
    expect(buildVariationNameMap([]).size).toBe(0);
  });

  it("memoizes by array reference", () => {
    const items = [item({ id: "i1", name: "IPA", variations: [variation({ id: "v1", item_variation_data: { item_id: "i1", name: "a" } })] })];
    expect(buildVariationNameMap(items)).toBe(buildVariationNameMap(items));
  });
});

import { describe, it, expect } from "vitest";
import { buildNonComboCocktailVariationIds, detectCocktailSales } from "./cocktails";
import type { CatalogItem, Order, OrderLineItem } from "@/types/square";

const COCKTAIL_CAT = "IPD6T7FOCCZBXG2HOPOVFB4J"; // Cocktails (main)
const CANS_CAT = "Q5BMUOAOCBOUS4JNDRAAXA4Q"; // not a cocktail

function variation(id: string, name: string, itemId: string, priceCents?: number) {
  return {
    type: "ITEM_VARIATION" as const,
    id,
    item_variation_data: {
      item_id: itemId,
      name,
      ...(priceCents !== undefined ? { price_money: { amount: priceCents, currency: "USD" } } : {}),
    },
  };
}

function item(opts: {
  id: string;
  name: string;
  categoryId: string;
  productType?: string;
  variations: ReturnType<typeof variation>[];
  slots?: string[][];
}): CatalogItem {
  return {
    type: "ITEM",
    id: opts.id,
    item_data: {
      name: opts.name,
      product_type: opts.productType ?? "FOOD_AND_BEV",
      reporting_category: { id: opts.categoryId, ordinal: 0 },
      variations: opts.variations,
      ...(opts.slots
        ? {
            combo_type_details: {
              slots: opts.slots.map((ids, i) => ({
                uid: `slot${i}`,
                name: `Slot ${i}`,
                num_selections: 1,
                item_variation_ids: ids,
              })),
            },
          }
        : {}),
    },
  };
}

function line(opts: Partial<OrderLineItem> & { uid: string }): OrderLineItem {
  return { quantity: opts.quantity ?? "1", name: opts.name ?? "X", ...opts };
}

function order(id: string, lines: OrderLineItem[], extra: Partial<Order> = {}): Order {
  return {
    id,
    location_id: "L1",
    state: "COMPLETED",
    created_at: "2026-06-01T00:00:00Z",
    closed_at: "2026-06-01T01:00:00Z",
    line_items: lines,
    ...extra,
  };
}

describe("buildNonComboCocktailVariationIds", () => {
  it("collects variation ids for non-COMBO cocktail items", () => {
    const items = [
      item({ id: "i1", name: "Margarita", categoryId: COCKTAIL_CAT, variations: [variation("v1", "Single", "i1"), variation("v2", "Double", "i1")] }),
    ];
    const ids = buildNonComboCocktailVariationIds(items);
    expect([...ids].sort()).toEqual(["v1", "v2"]);
  });

  it("excludes COMBO items even in the cocktail category", () => {
    const items = [
      item({ id: "i1", name: "BYO", categoryId: COCKTAIL_CAT, productType: "COMBO", variations: [variation("v1", "Regular", "i1", 1200)], slots: [["x"]] }),
    ];
    expect(buildNonComboCocktailVariationIds(items).size).toBe(0);
  });

  it("excludes items outside the cocktail category", () => {
    const items = [item({ id: "i1", name: "Beer Can", categoryId: CANS_CAT, variations: [variation("v1", "Loose", "i1")] })];
    expect(buildNonComboCocktailVariationIds(items).size).toBe(0);
  });

  it("returns empty set for empty input", () => {
    expect(buildNonComboCocktailVariationIds([]).size).toBe(0);
  });

  it("memoizes by reference", () => {
    const items = [item({ id: "i1", name: "Margarita", categoryId: COCKTAIL_CAT, variations: [variation("v1", "Single", "i1")] })];
    expect(buildNonComboCocktailVariationIds(items)).toBe(buildNonComboCocktailVariationIds(items));
  });
});

describe("detectCocktailSales — non-combo path", () => {
  const items = [
    item({ id: "i1", name: "Margarita", categoryId: COCKTAIL_CAT, variations: [variation("v1", "Single", "i1", 900)] }),
  ];

  it("detects a non-combo cocktail with money fields and net = gross - discounts", () => {
    const o = order("o1", [
      line({ uid: "li1", catalog_object_id: "v1", quantity: "2",
        gross_sales_money: { amount: 1800, currency: "USD" },
        total_discount_money: { amount: 200, currency: "USD" },
        total_tax_money: { amount: 100, currency: "USD" } }),
    ]);
    const { sales, comboClaimedKeys } = detectCocktailSales([o], items);
    expect(sales).toHaveLength(1);
    expect(sales[0].isCombo).toBe(false);
    expect(sales[0].itemName).toBe("Margarita");
    expect(sales[0].variationName).toBe("Single");
    expect(sales[0].quantity).toBe(2);
    expect(sales[0].grossSalesCents).toBe(1800);
    expect(sales[0].discountsCents).toBe(200);
    expect(sales[0].netSalesCents).toBe(1600);
    expect(sales[0].taxCents).toBe(100);
    expect(comboClaimedKeys.size).toBe(0);
  });

  it("ignores line items not in the cocktail variation set", () => {
    const o = order("o1", [line({ uid: "li1", catalog_object_id: "not-cocktail" })]);
    expect(detectCocktailSales([o], items).sales).toHaveLength(0);
  });

  it("returns empty for empty orders", () => {
    expect(detectCocktailSales([], items).sales).toEqual([]);
  });
});

describe("detectCocktailSales — combo aggregation path", () => {
  // A combo with 2 slots; component variations comp1 (standalone 800) and comp2 (standalone 700).
  const items = [
    item({
      id: "combo1",
      name: "Build-Your-Own Cocktail",
      categoryId: COCKTAIL_CAT,
      productType: "COMBO",
      variations: [variation("cv1", "Regular", "combo1", 1500)],
      slots: [["comp1"], ["comp2"]],
    }),
    item({ id: "ci1", name: "Well Vodka", categoryId: CANS_CAT, variations: [variation("comp1", "Shot", "ci1", 800)] }),
    item({ id: "ci2", name: "Mixer", categoryId: CANS_CAT, variations: [variation("comp2", "Splash", "ci2", 700)] }),
  ];

  it("aggregates combo components into one sale and divides qty by numSlots", () => {
    // Each component charged at a price != standalone → combo signal.
    const o = order("o1", [
      line({ uid: "a", catalog_object_id: "comp1", quantity: "1", base_price_money: { amount: 750, currency: "USD" }, gross_sales_money: { amount: 750, currency: "USD" } }),
      line({ uid: "b", catalog_object_id: "comp2", quantity: "1", base_price_money: { amount: 750, currency: "USD" }, gross_sales_money: { amount: 750, currency: "USD" } }),
    ]);
    const { sales, comboClaimedKeys } = detectCocktailSales([o], items);
    expect(sales).toHaveLength(1);
    const sale = sales[0];
    expect(sale.isCombo).toBe(true);
    expect(sale.itemName).toBe("Build-Your-Own Cocktail");
    // totalComponentQty (1+1) / numSlots (2) = 1
    expect(sale.quantity).toBe(1);
    expect(sale.grossSalesCents).toBe(1500);
    expect(sale.netSalesCents).toBe(1500);
    expect(sale.rawLineItems).toHaveLength(2);
    // Both component line items are claimed
    expect(comboClaimedKeys.has("o1:a")).toBe(true);
    expect(comboClaimedKeys.has("o1:b")).toBe(true);
  });

  it("does not treat a component charged at its standalone price as a combo", () => {
    const o = order("o1", [
      line({ uid: "a", catalog_object_id: "comp1", base_price_money: { amount: 800, currency: "USD" } }),
    ]);
    expect(detectCocktailSales([o], items).sales).toHaveLength(0);
  });
});

describe("detectCocktailSales — sort order", () => {
  const items = [item({ id: "i1", name: "Margarita", categoryId: COCKTAIL_CAT, variations: [variation("v1", "Single", "i1", 900)] })];

  it("sorts by orderClosedAt descending", () => {
    const oEarly = order("early", [line({ uid: "l", catalog_object_id: "v1", gross_sales_money: { amount: 1, currency: "USD" } })], { closed_at: "2026-01-01T00:00:00Z" });
    const oLate = order("late", [line({ uid: "l", catalog_object_id: "v1", gross_sales_money: { amount: 1, currency: "USD" } })], { closed_at: "2026-12-01T00:00:00Z" });
    expect(detectCocktailSales([oEarly, oLate], items).sales.map((s) => s.orderId)).toEqual(["late", "early"]);
  });
});

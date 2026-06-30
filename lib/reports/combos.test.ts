import { describe, it, expect } from "vitest";
import {
  buildComboIndex,
  buildComponentIndex,
  detectComboSales,
  type ComboDefinition,
} from "./combos";
import type { CatalogItem, Order, OrderLineItem } from "@/types/square";

// Cocktails (main) category ID — from CATEGORY_IDS.COCKTAILS
const COCKTAIL_CAT = "IPD6T7FOCCZBXG2HOPOVFB4J";
const NON_COCKTAIL_CAT = "Q5BMUOAOCBOUS4JNDRAAXA4Q"; // Cans

function comboItem(opts: {
  id: string;
  variationId: string;
  name: string;
  categoryId: string;
  priceCents?: number | undefined;
  slots: string[][]; // each slot is a list of component variation ids
  productType?: string;
}): CatalogItem {
  return {
    type: "ITEM",
    id: opts.id,
    item_data: {
      name: opts.name,
      product_type: opts.productType ?? "COMBO",
      reporting_category: { id: opts.categoryId, ordinal: 0 },
      variations: [
        {
          type: "ITEM_VARIATION",
          id: opts.variationId,
          item_variation_data: {
            item_id: opts.id,
            name: "Regular",
            ...(opts.priceCents !== undefined
              ? { price_money: { amount: opts.priceCents, currency: "USD" } }
              : {}),
          },
        },
      ],
      combo_type_details: {
        slots: opts.slots.map((ids, i) => ({
          uid: `slot${i}`,
          name: `Slot ${i}`,
          num_selections: 1,
          item_variation_ids: ids,
        })),
      },
    },
  };
}

function line(opts: Partial<OrderLineItem> & { uid: string }): OrderLineItem {
  return {
    quantity: opts.quantity ?? "1",
    name: opts.name ?? "Component",
    ...opts,
  };
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

describe("buildComboIndex", () => {
  it("includes a COMBO item in the Cocktails category", () => {
    const items = [
      comboItem({ id: "c1", variationId: "cv1", name: "Build-Your-Own", categoryId: COCKTAIL_CAT, priceCents: 1200, slots: [["a", "b"], ["c"]] }),
    ];
    const combos = buildComboIndex(items);
    expect(combos).toHaveLength(1);
    expect(combos[0].catalogItemId).toBe("c1");
    expect(combos[0].variationId).toBe("cv1");
    expect(combos[0].name).toBe("Build-Your-Own");
    expect(combos[0].priceCents).toBe(1200);
    expect(combos[0].numSlots).toBe(2);
    expect([...combos[0].componentVariationIds].sort()).toEqual(["a", "b", "c"]);
  });

  it("excludes non-COMBO product types", () => {
    const items = [
      comboItem({ id: "c1", variationId: "cv1", name: "Not A Combo", categoryId: COCKTAIL_CAT, priceCents: 1000, slots: [["a"]], productType: "FOOD_AND_BEV" }),
    ];
    expect(buildComboIndex(items)).toHaveLength(0);
  });

  it("excludes COMBO items outside the Cocktails category", () => {
    const items = [
      comboItem({ id: "c1", variationId: "cv1", name: "Combo", categoryId: NON_COCKTAIL_CAT, priceCents: 1000, slots: [["a"]] }),
    ];
    expect(buildComboIndex(items)).toHaveLength(0);
  });

  it("excludes a combo with no variations", () => {
    const item: CatalogItem = {
      type: "ITEM",
      id: "c1",
      item_data: {
        name: "Empty",
        product_type: "COMBO",
        reporting_category: { id: COCKTAIL_CAT, ordinal: 0 },
        variations: [],
        combo_type_details: { slots: [] },
      },
    };
    expect(buildComboIndex([item])).toHaveLength(0);
  });

  it("excludes a combo whose variation has no price_money", () => {
    const items = [
      comboItem({ id: "c1", variationId: "cv1", name: "No Price", categoryId: COCKTAIL_CAT, priceCents: undefined, slots: [["a"]] }),
    ];
    expect(buildComboIndex(items)).toHaveLength(0);
  });

  it("returns empty for empty input", () => {
    expect(buildComboIndex([])).toEqual([]);
  });

  it("memoizes by reference (same array returns identical result)", () => {
    const items = [
      comboItem({ id: "c1", variationId: "cv1", name: "Combo", categoryId: COCKTAIL_CAT, priceCents: 1000, slots: [["a"]] }),
    ];
    expect(buildComboIndex(items)).toBe(buildComboIndex(items));
  });
});

describe("buildComponentIndex", () => {
  it("maps each component variation id to its combo", () => {
    const combos: ComboDefinition[] = [
      { catalogItemId: "c1", variationId: "cv1", name: "Combo A", categoryId: COCKTAIL_CAT, priceCents: 1200, numSlots: 2, componentVariationIds: new Set(["a", "b"]) },
    ];
    const idx = buildComponentIndex(combos);
    expect(idx.get("a")?.name).toBe("Combo A");
    expect(idx.get("b")?.name).toBe("Combo A");
    expect(idx.get("z")).toBeUndefined();
  });

  it("returns empty map for empty combos", () => {
    expect(buildComponentIndex([]).size).toBe(0);
  });
});

describe("detectComboSales", () => {
  const combos: ComboDefinition[] = [
    { catalogItemId: "c1", variationId: "cv1", name: "Combo A", categoryId: COCKTAIL_CAT, priceCents: 1200, numSlots: 2, componentVariationIds: new Set(["comp1"]) },
  ];
  const componentIndex = buildComponentIndex(combos);
  const standalonePrices = new Map<string, number>([["comp1", 800]]);
  const variationNames = new Map([
    ["comp1", { itemName: "Well Vodka", variationName: "Shot", itemId: "i1" }],
  ]);

  it("detects a sale when charged price differs from standalone price", () => {
    const o = order("o1", [
      line({ uid: "li1", catalog_object_id: "comp1", quantity: "2", base_price_money: { amount: 600, currency: "USD" }, gross_sales_money: { amount: 1200, currency: "USD" } }),
    ]);
    const sales = detectComboSales([o], componentIndex, standalonePrices, variationNames);
    expect(sales).toHaveLength(1);
    expect(sales[0].comboName).toBe("Combo A");
    expect(sales[0].componentName).toBe("Well Vodka");
    expect(sales[0].pricedAtCents).toBe(600);
    expect(sales[0].componentStandalonePriceCents).toBe(800);
    expect(sales[0].quantity).toBe(2);
    expect(sales[0].grossSalesCents).toBe(1200);
    expect(sales[0].netSalesCents).toBe(1200);
  });

  it("skips a line charged at the standalone price (no combo signal)", () => {
    const o = order("o1", [
      line({ uid: "li1", catalog_object_id: "comp1", quantity: "1", base_price_money: { amount: 800, currency: "USD" } }),
    ]);
    expect(detectComboSales([o], componentIndex, standalonePrices, variationNames)).toHaveLength(0);
  });

  it("skips lines with no catalog_object_id", () => {
    const o = order("o1", [line({ uid: "li1", base_price_money: { amount: 600, currency: "USD" } })]);
    expect(detectComboSales([o], componentIndex, standalonePrices, variationNames)).toHaveLength(0);
  });

  it("skips lines whose variation is not a combo component", () => {
    const o = order("o1", [line({ uid: "li1", catalog_object_id: "other", base_price_money: { amount: 1, currency: "USD" } })]);
    expect(detectComboSales([o], componentIndex, standalonePrices, variationNames)).toHaveLength(0);
  });

  it("skips a component with no standalone price recorded", () => {
    const o = order("o1", [line({ uid: "li1", catalog_object_id: "comp1", base_price_money: { amount: 600, currency: "USD" } })]);
    const sales = detectComboSales([o], componentIndex, new Map(), variationNames);
    expect(sales).toHaveLength(0);
  });

  it("defaults pricedAt to 0 when base_price_money missing (differs from 800 standalone → detected)", () => {
    const o = order("o1", [line({ uid: "li1", catalog_object_id: "comp1", quantity: "3" })]);
    const sales = detectComboSales([o], componentIndex, standalonePrices, variationNames);
    expect(sales).toHaveLength(1);
    expect(sales[0].pricedAtCents).toBe(0);
    // gross falls back to pricedAt * qty = 0
    expect(sales[0].grossSalesCents).toBe(0);
  });

  it("computes discounts and net (gross - discounts)", () => {
    const o = order("o1", [
      line({
        uid: "li1",
        catalog_object_id: "comp1",
        base_price_money: { amount: 600, currency: "USD" },
        gross_sales_money: { amount: 600, currency: "USD" },
        total_discount_money: { amount: 100, currency: "USD" },
        total_tax_money: { amount: 42, currency: "USD" },
      }),
    ]);
    const sales = detectComboSales([o], componentIndex, standalonePrices, variationNames);
    expect(sales[0].discountsCents).toBe(100);
    expect(sales[0].netSalesCents).toBe(500);
    expect(sales[0].taxCents).toBe(42);
  });

  it("falls back to line name when no variation name entry exists", () => {
    const o = order("o1", [
      line({ uid: "li1", catalog_object_id: "comp1", name: "Fallback Name", variation_name: "VarFallback", base_price_money: { amount: 600, currency: "USD" } }),
    ]);
    const sales = detectComboSales([o], componentIndex, standalonePrices, new Map());
    expect(sales[0].componentName).toBe("Fallback Name");
    expect(sales[0].componentVariationName).toBe("VarFallback");
  });

  it("uses created_at when closed_at absent", () => {
    const o = order("o1", [line({ uid: "li1", catalog_object_id: "comp1", base_price_money: { amount: 600, currency: "USD" } })], { closed_at: undefined });
    const sales = detectComboSales([o], componentIndex, standalonePrices, variationNames);
    expect(sales[0].orderClosedAt).toBe("2026-06-01T00:00:00Z");
  });

  it("sorts results by orderClosedAt descending", () => {
    const oEarly = order("early", [line({ uid: "l", catalog_object_id: "comp1", base_price_money: { amount: 1, currency: "USD" } })], { closed_at: "2026-01-01T00:00:00Z" });
    const oLate = order("late", [line({ uid: "l", catalog_object_id: "comp1", base_price_money: { amount: 1, currency: "USD" } })], { closed_at: "2026-12-01T00:00:00Z" });
    const sales = detectComboSales([oEarly, oLate], componentIndex, standalonePrices, variationNames);
    expect(sales.map((s) => s.orderId)).toEqual(["late", "early"]);
  });

  it("returns empty for empty orders", () => {
    expect(detectComboSales([], componentIndex, standalonePrices, variationNames)).toEqual([]);
  });
});

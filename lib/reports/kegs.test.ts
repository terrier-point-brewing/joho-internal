import { describe, it, expect } from "vitest";
import { buildKegIndex, detectKegSales, type KegDefinition } from "./kegs";
import { KEG_TRANSFER_DISCOUNT_NAME } from "@/types/reports";
import type { CatalogItem, Order, OrderLineItem } from "@/types/square";

const KEGS_CAT = "FXHTXXAICGRPMGJAHGJZ34MY"; // Kegs (main)
const CANS_CAT = "Q5BMUOAOCBOUS4JNDRAAXA4Q"; // Cans

function kegItem(opts: {
  id: string;
  name: string;
  categoryId?: string;
  variations: { id: string; name: string }[];
}): CatalogItem {
  return {
    type: "ITEM",
    id: opts.id,
    item_data: {
      name: opts.name,
      product_type: "FOOD_AND_BEV",
      reporting_category: { id: opts.categoryId ?? KEGS_CAT, ordinal: 0 },
      variations: opts.variations.map((v) => ({
        type: "ITEM_VARIATION",
        id: v.id,
        item_variation_data: { item_id: opts.id, name: v.name },
      })),
    },
  };
}

function line(opts: Partial<OrderLineItem> & { uid: string }): OrderLineItem {
  return { quantity: opts.quantity ?? "1", name: opts.name ?? "Keg", ...opts };
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

describe("buildKegIndex", () => {
  it("indexes keg-size variations in keg categories", () => {
    const items = [
      kegItem({ id: "i1", name: "Carolina Pale Ale (Keg)", variations: [
        { id: "v1", name: "1/2 Keg" },
        { id: "v2", name: "1/6 Keg" },
      ] }),
    ];
    const idx = buildKegIndex(items);
    expect(idx.size).toBe(2);
    expect(idx.get("v1")).toEqual({ catalogItemId: "i1", variationId: "v1", beerName: "Carolina Pale Ale", kegSize: "1/2 Keg" });
    expect(idx.get("v2")?.kegSize).toBe("1/6 Keg");
  });

  it("strips ' (Keg)' suffix from beer name", () => {
    const items = [kegItem({ id: "i1", name: "Epic Hazy (Keg)", variations: [{ id: "v1", name: "1/4 Keg" }] })];
    expect(buildKegIndex(items).get("v1")?.beerName).toBe("Epic Hazy");
  });

  it("skips deposit variations (non keg-size names like 'Regular')", () => {
    const items = [kegItem({ id: "i1", name: "Deposit (Keg)", variations: [{ id: "v1", name: "Regular" }] })];
    expect(buildKegIndex(items).size).toBe(0);
  });

  it("skips items not in a keg category", () => {
    const items = [kegItem({ id: "i1", name: "Cans Item", categoryId: CANS_CAT, variations: [{ id: "v1", name: "1/2 Keg" }] })];
    expect(buildKegIndex(items).size).toBe(0);
  });

  it("returns empty for empty input", () => {
    expect(buildKegIndex([]).size).toBe(0);
  });

  it("memoizes by reference", () => {
    const items = [kegItem({ id: "i1", name: "X (Keg)", variations: [{ id: "v1", name: "1/2 Keg" }] })];
    expect(buildKegIndex(items)).toBe(buildKegIndex(items));
  });
});

describe("detectKegSales", () => {
  const kegIndex = new Map<string, KegDefinition>([
    ["v1", { catalogItemId: "i1", variationId: "v1", beerName: "Carolina Pale Ale", kegSize: "1/2 Keg" }],
  ]);

  it("returns one sale per keg line item with money fields", () => {
    const o = order("o1", [
      line({ uid: "li1", catalog_object_id: "v1", quantity: "2",
        gross_sales_money: { amount: 30000, currency: "USD" },
        total_discount_money: { amount: 2000, currency: "USD" },
        total_tax_money: { amount: 500, currency: "USD" } }),
    ]);
    const sales = detectKegSales([o], kegIndex);
    expect(sales).toHaveLength(1);
    expect(sales[0].beerName).toBe("Carolina Pale Ale");
    expect(sales[0].kegSize).toBe("1/2 Keg");
    expect(sales[0].quantity).toBe(2);
    expect(sales[0].grossSalesCents).toBe(30000);
    expect(sales[0].discountsCents).toBe(2000);
    expect(sales[0].netSalesCents).toBe(28000);
    expect(sales[0].taxCents).toBe(500);
    expect(sales[0].isTransfer).toBe(false);
  });

  it("flags isTransfer when the keg transfer discount is applied", () => {
    const o = order("o1", [
      line({ uid: "li1", catalog_object_id: "v1", applied_discounts: [{ uid: "ad1", discount_uid: "d1" }] }),
    ], { discounts: [{ uid: "d1", name: KEG_TRANSFER_DISCOUNT_NAME }] });
    const sales = detectKegSales([o], kegIndex);
    expect(sales[0].isTransfer).toBe(true);
    expect(sales[0].discountNames).toContain(KEG_TRANSFER_DISCOUNT_NAME);
  });

  it("does not flag transfer for an unrelated discount", () => {
    const o = order("o1", [
      line({ uid: "li1", catalog_object_id: "v1", applied_discounts: [{ uid: "ad1", discount_uid: "d1" }] }),
    ], { discounts: [{ uid: "d1", name: "Happy Hour" }] });
    const sales = detectKegSales([o], kegIndex);
    expect(sales[0].isTransfer).toBe(false);
    expect(sales[0].discountNames).toEqual(["Happy Hour"]);
  });

  it("maps an unknown discount_uid to 'Unknown Discount'", () => {
    const o = order("o1", [
      line({ uid: "li1", catalog_object_id: "v1", applied_discounts: [{ uid: "ad1", discount_uid: "missing" }] }),
    ], { discounts: [] });
    const sales = detectKegSales([o], kegIndex);
    expect(sales[0].discountNames).toEqual(["Unknown Discount"]);
  });

  it("ignores non-keg line items and lines without catalog_object_id", () => {
    const o = order("o1", [
      line({ uid: "li1", catalog_object_id: "not-a-keg" }),
      line({ uid: "li2" }),
    ]);
    expect(detectKegSales([o], kegIndex)).toHaveLength(0);
  });

  it("defaults quantity to 1 and money to 0 when fields are absent", () => {
    const o = order("o1", [line({ uid: "li1", catalog_object_id: "v1" })]);
    const sales = detectKegSales([o], kegIndex);
    expect(sales[0].quantity).toBe(1);
    expect(sales[0].grossSalesCents).toBe(0);
    expect(sales[0].netSalesCents).toBe(0);
  });

  it("uses created_at when closed_at absent", () => {
    const o = order("o1", [line({ uid: "li1", catalog_object_id: "v1" })], { closed_at: undefined });
    expect(detectKegSales([o], kegIndex)[0].orderClosedAt).toBe("2026-06-01T00:00:00Z");
  });

  it("sorts by orderClosedAt descending", () => {
    const oEarly = order("early", [line({ uid: "l", catalog_object_id: "v1" })], { closed_at: "2026-01-01T00:00:00Z" });
    const oLate = order("late", [line({ uid: "l", catalog_object_id: "v1" })], { closed_at: "2026-12-01T00:00:00Z" });
    expect(detectKegSales([oEarly, oLate], kegIndex).map((s) => s.orderId)).toEqual(["late", "early"]);
  });

  it("returns empty for empty orders", () => {
    expect(detectKegSales([], kegIndex)).toEqual([]);
  });
});

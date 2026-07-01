import { describe, it, expect } from "vitest";
import { buildDistributionReport } from "./distribution";
import type { SquareCustomer } from "@/lib/square/customers";
import type { CatalogItem, Order, OrderLineItem } from "@/types/square";

const KEGS_CAT = "FXHTXXAICGRPMGJAHGJZ34MY";
const CANS_CAT = "Q5BMUOAOCBOUS4JNDRAAXA4Q";
const OTHER_CAT = "VS5QIJ7EH56OXJ3OOMNCJVHP"; // Snacks

function makeItem(opts: {
  id: string;
  name: string;
  categoryId: string;
  variations: { id: string; name: string }[];
}): CatalogItem {
  return {
    type: "ITEM",
    id: opts.id,
    item_data: {
      name: opts.name,
      product_type: "FOOD_AND_BEV",
      reporting_category: { id: opts.categoryId, ordinal: 0 },
      variations: opts.variations.map((v) => ({
        type: "ITEM_VARIATION",
        id: v.id,
        item_variation_data: { item_id: opts.id, name: v.name },
      })),
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
    state: "OPEN",
    created_at: "2026-06-01T00:00:00Z",
    line_items: lines,
    ...extra,
  };
}

const items = [
  makeItem({ id: "k1", name: "Pale Ale (Keg)", categoryId: KEGS_CAT, variations: [
    { id: "half", name: "1/2 Keg" },
    { id: "sixth", name: "1/6 Keg" },
    { id: "quarter", name: "1/4 Keg" },
    { id: "dep", name: "Regular" }, // deposit — should be skipped
  ] }),
  makeItem({ id: "c1", name: "Pale Ale (Cans)", categoryId: CANS_CAT, variations: [
    { id: "can4", name: "16oz 4-Pack" },
  ] }),
];

describe("buildDistributionReport — bySize", () => {
  it("aggregates qty / gross / discounts / net per size in fixed order", () => {
    const o = order("o1", [
      line({ uid: "a", catalog_object_id: "half", quantity: "2", gross_sales_money: { amount: 30000, currency: "USD" }, total_discount_money: { amount: 1000, currency: "USD" } }),
      line({ uid: "b", catalog_object_id: "can4", quantity: "5", gross_sales_money: { amount: 5000, currency: "USD" } }),
    ], { customer_id: "x", total_money: { amount: 35000, currency: "USD" } });
    const { bySize } = buildDistributionReport([o], items, new Map());
    expect(bySize.map((r) => r.size)).toEqual(["1/2 Keg", "Cans"]); // order: 1/2,1/4,1/6,Cans,Other (zero filtered)
    const half = bySize.find((r) => r.size === "1/2 Keg")!;
    expect(half.qty).toBe(2);
    expect(half.grossCents).toBe(30000);
    expect(half.discountsCents).toBe(1000);
    expect(half.netCents).toBe(29000);
    const cans = bySize.find((r) => r.size === "Cans")!;
    expect(cans.qty).toBe(5);
    expect(cans.netCents).toBe(5000);
  });

  it("filters out zero-qty sizes", () => {
    const o = order("o1", [line({ uid: "a", catalog_object_id: "sixth", quantity: "1", gross_sales_money: { amount: 1, currency: "USD" } })], { customer_id: "x", total_money: { amount: 1, currency: "USD" } });
    const { bySize } = buildDistributionReport([o], items, new Map());
    expect(bySize.map((r) => r.size)).toEqual(["1/6 Keg"]);
  });

  it("skips keg deposit variations (name not matching keg-size pattern)", () => {
    const o = order("o1", [line({ uid: "a", catalog_object_id: "dep", quantity: "9", gross_sales_money: { amount: 999, currency: "USD" } })], { customer_id: "x", total_money: { amount: 999, currency: "USD" } });
    // 'dep' variation is never indexed → order has no dist item → nothing recorded
    const { bySize } = buildDistributionReport([o], items, new Map());
    expect(bySize).toEqual([]);
  });

  it("returns empty bySize for empty orders", () => {
    expect(buildDistributionReport([], items, new Map()).bySize).toEqual([]);
  });
});

describe("buildDistributionReport — byCustomer", () => {
  it("aggregates per-size counts, invoice count, charged, and outstanding", () => {
    const customers = new Map<string, SquareCustomer>([["c1", { id: "c1", given_name: "Joe", family_name: "Bar" }]]);
    const o = order("o1", [
      line({ uid: "a", catalog_object_id: "half", quantity: "3", gross_sales_money: { amount: 1, currency: "USD" } }),
      line({ uid: "b", catalog_object_id: "quarter", quantity: "1", gross_sales_money: { amount: 1, currency: "USD" } }),
      line({ uid: "c", catalog_object_id: "sixth", quantity: "2", gross_sales_money: { amount: 1, currency: "USD" } }),
      line({ uid: "d", catalog_object_id: "can4", quantity: "4", gross_sales_money: { amount: 1, currency: "USD" } }),
    ], { customer_id: "c1", total_money: { amount: 50000, currency: "USD" }, net_amount_due_money: { amount: 20000, currency: "USD" } });
    const { byCustomer } = buildDistributionReport([o], items, customers);
    expect(byCustomer).toHaveLength(1);
    const c = byCustomer[0];
    expect(c.customerName).toBe("Joe Bar");
    expect(c.invoiceCount).toBe(1);
    expect(c.totalChargedCents).toBe(50000);
    expect(c.totalOutstandingCents).toBe(20000);
    expect(c.halfKegQty).toBe(3);
    expect(c.quarterKegQty).toBe(1);
    expect(c.sixthKegQty).toBe(2);
    expect(c.cansQty).toBe(4);
  });

  it("uses 'unknown'/'Unknown' when customer_id missing", () => {
    const o = order("o1", [line({ uid: "a", catalog_object_id: "half", quantity: "1", gross_sales_money: { amount: 1, currency: "USD" } })], { total_money: { amount: 1, currency: "USD" } });
    const { byCustomer } = buildDistributionReport([o], items, new Map());
    expect(byCustomer[0].customerId).toBe("unknown");
    expect(byCustomer[0].customerName).toBe("Unknown");
  });

  it("sorts customers by totalChargedCents descending", () => {
    const small = order("o1", [line({ uid: "a", catalog_object_id: "half", quantity: "1", gross_sales_money: { amount: 1, currency: "USD" } })], { customer_id: "small", total_money: { amount: 1, currency: "USD" } });
    const big = order("o2", [line({ uid: "b", catalog_object_id: "half", quantity: "1", gross_sales_money: { amount: 1, currency: "USD" } })], { customer_id: "big", total_money: { amount: 99999, currency: "USD" } });
    const { byCustomer } = buildDistributionReport([small, big], items, new Map());
    expect(byCustomer.map((c) => c.customerId)).toEqual(["big", "small"]);
  });

  it("ignores orders with no distribution items", () => {
    const itemsWithSnack = [...items, makeItem({ id: "s1", name: "Pretzel", categoryId: OTHER_CAT, variations: [{ id: "snk", name: "Each" }] })];
    const o = order("o1", [line({ uid: "a", catalog_object_id: "snk", quantity: "1", gross_sales_money: { amount: 1, currency: "USD" } })], { customer_id: "c1", total_money: { amount: 1, currency: "USD" } });
    const { byCustomer } = buildDistributionReport([o], itemsWithSnack, new Map());
    expect(byCustomer).toHaveLength(0);
  });
});

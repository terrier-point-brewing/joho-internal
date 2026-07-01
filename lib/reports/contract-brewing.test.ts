import { describe, it, expect } from "vitest";
import { buildContractBrewingReport } from "./contract-brewing";
import type { SquareCustomer } from "@/lib/square/customers";
import type { CatalogItem, Order, OrderLineItem } from "@/types/square";

const CB_CAT = "CDX2UMLF35B4I3F7ILYLMWMF"; // Contract Brewing
const OTHER_CAT = "Q5BMUOAOCBOUS4JNDRAAXA4Q"; // Cans

function cbItem(id: string, name: string, variationId: string, categoryId = CB_CAT): CatalogItem {
  return {
    type: "ITEM",
    id,
    item_data: {
      name,
      product_type: "FOOD_AND_BEV",
      reporting_category: { id: categoryId, ordinal: 0 },
      variations: [{ type: "ITEM_VARIATION", id: variationId, item_variation_data: { item_id: id, name: "Regular" } }],
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

describe("buildContractBrewingReport — byCategory", () => {
  const items = [
    cbItem("i1", "Ingredient Deposit", "v1"),
    cbItem("i2", "Packaging Fee", "v2"),
    cbItem("i3", "Keg Cleaning", "v3"),
    cbItem("i4", "Barrel Excise Tax", "v4"),
  ];
  const customers = new Map<string, SquareCustomer>();

  it("classifies each line into its subcategory with net = gross - discounts", () => {
    const o = order("o1", [
      line({ uid: "a", catalog_object_id: "v1", gross_sales_money: { amount: 5000, currency: "USD" }, total_discount_money: { amount: 500, currency: "USD" } }),
      line({ uid: "b", catalog_object_id: "v2", gross_sales_money: { amount: 3000, currency: "USD" } }),
      line({ uid: "c", catalog_object_id: "v3", gross_sales_money: { amount: 2000, currency: "USD" } }),
      line({ uid: "d", catalog_object_id: "v4", gross_sales_money: { amount: 1000, currency: "USD" } }),
    ]);
    const { byCategory } = buildContractBrewingReport([o], items, customers);
    const byId = Object.fromEntries(byCategory.map((r) => [r.subcategory, r]));

    expect(byId.MATERIALS_PACKAGING.grossCents).toBe(5000);
    expect(byId.MATERIALS_PACKAGING.discountsCents).toBe(500);
    expect(byId.MATERIALS_PACKAGING.netCents).toBe(4500);
    expect(byId.PACKAGING_FEES.netCents).toBe(3000);
    expect(byId.OTHER_SERVICES.netCents).toBe(2000);
    expect(byId.PASS_THROUGH_TAXES.netCents).toBe(1000);
  });

  it("returns all four subcategories in fixed order, even when zero", () => {
    const { byCategory } = buildContractBrewingReport([], items, customers);
    expect(byCategory.map((r) => r.subcategory)).toEqual([
      "MATERIALS_PACKAGING", "PACKAGING_FEES", "OTHER_SERVICES", "PASS_THROUGH_TAXES",
    ]);
    expect(byCategory.every((r) => r.grossCents === 0 && r.netCents === 0)).toBe(true);
  });

  it("attaches human-readable labels", () => {
    const { byCategory } = buildContractBrewingReport([], items, customers);
    const byId = Object.fromEntries(byCategory.map((r) => [r.subcategory, r.label]));
    expect(byId.MATERIALS_PACKAGING).toBe("Materials & Packaging");
    expect(byId.PASS_THROUGH_TAXES).toBe("Pass-Through Taxes");
  });

  it("ignores non-contract-brewing line items in the same order", () => {
    const itemsMixed = [...items, cbItem("i5", "Some Beer", "v5", OTHER_CAT)];
    const o = order("o1", [
      line({ uid: "a", catalog_object_id: "v1", gross_sales_money: { amount: 5000, currency: "USD" } }),
      line({ uid: "x", catalog_object_id: "v5", gross_sales_money: { amount: 9999, currency: "USD" } }),
    ]);
    const { byCategory } = buildContractBrewingReport([o], itemsMixed, customers);
    const total = byCategory.reduce((s, r) => s + r.grossCents, 0);
    expect(total).toBe(5000); // v5 excluded
  });
});

describe("buildContractBrewingReport — byCustomer", () => {
  const items = [cbItem("i1", "Packaging Fee", "v1")];

  it("aggregates invoice count, charged, and outstanding per customer", () => {
    const customers = new Map<string, SquareCustomer>([
      ["cust1", { id: "cust1", company_name: "Hops Co" }],
    ]);
    const o1 = order("o1", [line({ uid: "a", catalog_object_id: "v1", gross_sales_money: { amount: 100, currency: "USD" } })], {
      customer_id: "cust1",
      total_money: { amount: 10000, currency: "USD" },
      net_amount_due_money: { amount: 4000, currency: "USD" },
    });
    const o2 = order("o2", [line({ uid: "b", catalog_object_id: "v1", gross_sales_money: { amount: 100, currency: "USD" } })], {
      customer_id: "cust1",
      total_money: { amount: 5000, currency: "USD" },
      net_amount_due_money: { amount: 0, currency: "USD" },
    });
    const { byCustomer } = buildContractBrewingReport([o1, o2], items, customers);
    expect(byCustomer).toHaveLength(1);
    expect(byCustomer[0].customerName).toBe("Hops Co");
    expect(byCustomer[0].invoiceCount).toBe(2);
    expect(byCustomer[0].totalChargedCents).toBe(15000);
    expect(byCustomer[0].totalOutstandingCents).toBe(4000);
  });

  it("uses 'unknown' bucket and 'Unknown' name when customer_id missing", () => {
    const o = order("o1", [line({ uid: "a", catalog_object_id: "v1", gross_sales_money: { amount: 1, currency: "USD" } })], {
      total_money: { amount: 1000, currency: "USD" },
    });
    const { byCustomer } = buildContractBrewingReport([o], items, new Map());
    expect(byCustomer[0].customerId).toBe("unknown");
    expect(byCustomer[0].customerName).toBe("Unknown");
  });

  it("sorts customers by totalChargedCents descending", () => {
    const customers = new Map<string, SquareCustomer>();
    const small = order("o1", [line({ uid: "a", catalog_object_id: "v1", gross_sales_money: { amount: 1, currency: "USD" } })], { customer_id: "small", total_money: { amount: 100, currency: "USD" } });
    const big = order("o2", [line({ uid: "b", catalog_object_id: "v1", gross_sales_money: { amount: 1, currency: "USD" } })], { customer_id: "big", total_money: { amount: 99999, currency: "USD" } });
    const { byCustomer } = buildContractBrewingReport([small, big], items, customers);
    expect(byCustomer.map((c) => c.customerId)).toEqual(["big", "small"]);
  });

  it("skips orders with no contract brewing item", () => {
    const o = order("o1", [line({ uid: "a", catalog_object_id: "not-cb" })], { customer_id: "cust1", total_money: { amount: 1, currency: "USD" } });
    const { byCustomer } = buildContractBrewingReport([o], items, new Map());
    expect(byCustomer).toHaveLength(0);
  });

  it("returns empty byCustomer for empty orders", () => {
    expect(buildContractBrewingReport([], items, new Map()).byCustomer).toEqual([]);
  });
});

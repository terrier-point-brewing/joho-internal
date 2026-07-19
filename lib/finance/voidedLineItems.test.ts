import { describe, it, expect } from "vitest";
import {
  extractVoidedLineItems,
  voidedGrossSalesCents,
  type VoidedLineItem,
} from "./voidedLineItems";

describe("extractVoidedLineItems", () => {
  it("maps Square order line items to the read-only display shape", () => {
    const rawData = {
      id: "abc",
      line_items: [
        {
          uid: "li-1",
          name: "Archer Roose",
          variation_name: "Sauvignon Blanc",
          quantity: "1",
          gross_sales_money: { amount: 700, currency: "USD" },
          total_discount_money: { amount: 0, currency: "USD" },
          total_tax_money: { amount: 58, currency: "USD" },
        },
      ],
    };
    expect(extractVoidedLineItems(rawData)).toEqual<VoidedLineItem[]>([
      {
        uid: "li-1",
        name: "Archer Roose",
        variation_name: "Sauvignon Blanc",
        quantity: 1,
        gross_sales_cents: 700,
        discount_cents: 0,
        tax_cents: 58,
      },
    ]);
  });

  it("preserves discounts and multi-unit quantities", () => {
    const rawData = {
      line_items: [
        {
          uid: "li-2",
          name: "Untitled Art Seltzer",
          variation_name: "Strawberry Kiwi",
          quantity: "3",
          gross_sales_money: { amount: 1800 },
          total_discount_money: { amount: 100 },
          total_tax_money: { amount: 123 },
        },
      ],
    };
    const [item] = extractVoidedLineItems(rawData);
    expect(item.quantity).toBe(3);
    expect(item.discount_cents).toBe(100);
    expect(item.gross_sales_cents).toBe(1800);
  });

  it("defaults missing money/quantity fields to safe values", () => {
    const [item] = extractVoidedLineItems({ line_items: [{ uid: "x", name: "Mystery" }] });
    expect(item).toEqual<VoidedLineItem>({
      uid: "x",
      name: "Mystery",
      variation_name: null,
      quantity: 1,
      gross_sales_cents: 0,
      discount_cents: 0,
      tax_cents: 0,
    });
  });

  it("returns [] for null, non-object, or line-item-less raw data", () => {
    expect(extractVoidedLineItems(null)).toEqual([]);
    expect(extractVoidedLineItems("not an object")).toEqual([]);
    expect(extractVoidedLineItems({})).toEqual([]);
    expect(extractVoidedLineItems({ line_items: null })).toEqual([]);
  });
});

describe("voidedGrossSalesCents", () => {
  it("sums gross sales across items", () => {
    const items = extractVoidedLineItems({
      line_items: [
        { uid: "a", name: "A", quantity: "1", gross_sales_money: { amount: 700 } },
        { uid: "b", name: "B", quantity: "1", gross_sales_money: { amount: 400 } },
      ],
    });
    expect(voidedGrossSalesCents(items)).toBe(1100);
  });

  it("is 0 for an empty set", () => {
    expect(voidedGrossSalesCents([])).toBe(0);
  });
});

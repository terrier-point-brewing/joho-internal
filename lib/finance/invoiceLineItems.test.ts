import { describe, it, expect } from "vitest";
import { buildInvoiceLineItemRows, invoiceHeaderTotalsFromOrder, type LineItemIndexes } from "./invoiceLineItems";
import type { Order } from "@/types/square";

const emptyIndexes: LineItemIndexes = {
  kegIndex: new Map(),
  canVariationOz: new Map(),
  variationById: new Map(),
  itemNameByVariationId: new Map([["VAR1", "Barrel Excise Tax"]]),
};

function orderWith(lineItems: Order["line_items"], discounts?: Order["discounts"]): Order {
  return {
    id: "O1", location_id: "L", state: "OPEN", created_at: "2026-07-11T00:00:00Z",
    line_items: lineItems, discounts,
    total_money: { amount: 0, currency: "USD" },
  } as Order;
}

describe("buildInvoiceLineItemRows", () => {
  it("splits catalog identity (col1) from note (col2) and computes net = gross - discount", () => {
    const order = orderWith([
      {
        uid: "u1", catalog_object_id: "VAR1", quantity: "1", name: "Barrel Excise Tax",
        variation_name: "Regular", note: "TTB (1.50 bbls)",
        base_price_money: { amount: 525, currency: "USD" },
        gross_sales_money: { amount: 525, currency: "USD" },
        total_discount_money: { amount: 0, currency: "USD" },
        total_tax_money: { amount: 0, currency: "USD" },
        total_money: { amount: 525, currency: "USD" },
      },
    ]);
    const [row] = buildInvoiceLineItemRows("INV1", order, emptyIndexes, new Map());
    expect(row.line_item_name).toBe("Barrel Excise Tax");
    expect(row.variation_name).toBe("Regular");
    expect(row.note).toBe("TTB (1.50 bbls)");
    expect(row.square_catalog_variation_id).toBe("VAR1");
    expect(row.gross_sales_cents).toBe(525);
    expect(row.net_sales_cents).toBe(525);
    expect(row.total_cents).toBe(525);
  });

  it("records a line-scoped discount and nets it out of total", () => {
    const order = orderWith([
      {
        uid: "u1", catalog_object_id: "VARX", quantity: "40", name: "Vienna Lager (Keg)",
        variation_name: "1/6 Keg",
        base_price_money: { amount: 7900, currency: "USD" },
        gross_sales_money: { amount: 316000, currency: "USD" },
        total_discount_money: { amount: 94800, currency: "USD" },
        total_tax_money: { amount: 0, currency: "USD" },
        total_money: { amount: 221200, currency: "USD" },
      },
    ]);
    const [row] = buildInvoiceLineItemRows("INV1", order, emptyIndexes, new Map());
    expect(row.discount_cents).toBe(94800);
    expect(row.net_sales_cents).toBe(221200);
    expect(row.total_cents).toBe(221200);
  });

  it("keeps two same-variation lines distinct via note; both map to the same variation id", () => {
    const order = orderWith([
      { uid: "a", catalog_object_id: "VAR1", quantity: "1", name: "Barrel Excise Tax", variation_name: "Regular", note: "TTB (1.50 bbls)", gross_sales_money: { amount: 525, currency: "USD" }, total_money: { amount: 525, currency: "USD" } },
      { uid: "b", catalog_object_id: "VAR1", quantity: "1", name: "Barrel Excise Tax", variation_name: "Regular", note: "NC Dept of Revenue (46.50 gal)", gross_sales_money: { amount: 2883, currency: "USD" }, total_money: { amount: 2883, currency: "USD" } },
    ]);
    const rows = buildInvoiceLineItemRows("INV1", order, emptyIndexes, new Map());
    expect(rows).toHaveLength(2);
    expect(rows[0].note).not.toBe(rows[1].note);
    expect(rows[0].square_catalog_variation_id).toBe(rows[1].square_catalog_variation_id);
  });

  it("preserves an existing non-null COA (fill-nulls-only)", () => {
    const order = orderWith([
      { uid: "u1", catalog_object_id: "VAR1", quantity: "1", name: "Barrel Excise Tax", variation_name: "Regular", gross_sales_money: { amount: 525, currency: "USD" }, total_money: { amount: 525, currency: "USD" } },
    ]);
    const existing = new Map([[0, { chart_of_accounts_id: "USER-SET", bs_chart_of_accounts_id: null, pl_chart_of_accounts_id: null }]]);
    const [row] = buildInvoiceLineItemRows("INV1", order, emptyIndexes, existing);
    expect(row.chart_of_accounts_id).toBe("USER-SET");
  });
});

describe("invoiceHeaderTotalsFromOrder", () => {
  it("uses order.total_money as authoritative and sums order-scoped discounts", () => {
    const order = orderWith(
      [{ uid: "u", quantity: "1", name: "x", gross_sales_money: { amount: 100, currency: "USD" }, total_money: { amount: 100, currency: "USD" } }],
      [{ uid: "d", name: "Coupon", scope: "ORDER", applied_money: { amount: 50, currency: "USD" } }],
    );
    (order as { total_money: { amount: number; currency: string } }).total_money = { amount: 50, currency: "USD" };
    (order as { total_tax_money?: { amount: number; currency: string } }).total_tax_money = { amount: 0, currency: "USD" };
    const t = invoiceHeaderTotalsFromOrder(order);
    expect(t.total_cents).toBe(50);
    expect(t.discount_cents).toBe(50);
  });
});

import { describe, it, expect } from "vitest";
import { isInvoiceOrder } from "./invoiceOrders";
import type { Order } from "@/types/square";

function order(partial: Partial<Order>): Order {
  return { id: "o1", location_id: "L", state: "COMPLETED", created_at: "2026-07-07T20:00:00Z", ...partial };
}

describe("isInvoiceOrder", () => {
  it("flags Square-native invoices via source.name", () => {
    expect(isInvoiceOrder(order({ source: { name: "Invoices" } }))).toBe(true);
  });

  it("flags app-generated export invoices via metadata.type (source is the app name)", () => {
    // The July 7 leak: source.name is "tpb-reporting", not "Invoices".
    expect(
      isInvoiceOrder(
        order({ source: { name: "tpb-reporting" }, metadata: { source: "tpb-brewing", type: "export-invoice" } })
      )
    ).toBe(true);
  });

  it("flags app-generated deposit invoices via metadata.type", () => {
    expect(
      isInvoiceOrder(order({ metadata: { source: "tpb-brewing", type: "allocation-deposit" } }))
    ).toBe(true);
  });

  it("does NOT flag in-person POS sales", () => {
    expect(isInvoiceOrder(order({ source: { name: "Point of Sale" } }))).toBe(false);
  });

  it("does NOT flag orders with no source and no metadata", () => {
    expect(isInvoiceOrder(order({}))).toBe(false);
  });

  it("does NOT flag orders whose metadata.type is unrelated", () => {
    expect(isInvoiceOrder(order({ metadata: { type: "something-else" } }))).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { isReturnOrder, resolveSourceOrderIds } from "./returnOrders";
import type { Order } from "@/types/square";

describe("isReturnOrder", () => {
  it("flags the return order Square creates for a refund", () => {
    expect(isReturnOrder({ returns: [{ uid: "r1", source_order_id: "sale1" }] })).toBe(true);
  });

  it("does not flag a normal sale", () => {
    expect(isReturnOrder({})).toBe(false);
    expect(isReturnOrder({ returns: [] })).toBe(false);
  });
});

describe("resolveSourceOrderIds", () => {
  const order = (id: string, extra: Partial<Order> = {}): Order =>
    ({ id, location_id: "L1", state: "COMPLETED", created_at: "2026-07-19T00:00:00Z", ...extra }) as Order;

  it("maps a return order's own id to the sale it reverses", () => {
    const ret = order("return1", { returns: [{ uid: "r", source_order_id: "sale1" }] });
    const map = resolveSourceOrderIds([ret]);
    expect(map.get("return1")).toBe("sale1");
  });

  it("omits orders that carry no source_order_id (real sales)", () => {
    const sale = order("sale1", { line_items: [] });
    expect(resolveSourceOrderIds([sale]).has("sale1")).toBe(false);
  });

  it("takes the first source_order_id when several returns are present", () => {
    const ret = order("return1", {
      returns: [
        { uid: "a" }, // tip-only return, no source
        { uid: "b", source_order_id: "sale2" },
      ],
    });
    expect(resolveSourceOrderIds([ret]).get("return1")).toBe("sale2");
  });
});

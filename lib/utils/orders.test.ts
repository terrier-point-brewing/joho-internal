import { describe, it, expect } from "vitest";
import { mapDiscountsByUid } from "./orders";
import type { Order, OrderDiscount } from "@/types/square";

function discount(uid: string, name: string): OrderDiscount {
  return { uid, name };
}

function order(discounts?: OrderDiscount[]): Order {
  return {
    id: "order-1",
    location_id: "LZ8TH4A632YW0",
    state: "COMPLETED",
    created_at: "2026-06-30T12:00:00Z",
    discounts,
  };
}

describe("mapDiscountsByUid", () => {
  it("maps each discount uid to its name", () => {
    const m = mapDiscountsByUid(order([discount("d1", "Happy Hour"), discount("d2", "Staff")]));
    expect(m.get("d1")).toBe("Happy Hour");
    expect(m.get("d2")).toBe("Staff");
    expect(m.size).toBe(2);
  });

  it("returns an empty map when discounts is undefined", () => {
    const m = mapDiscountsByUid(order(undefined));
    expect(m.size).toBe(0);
  });

  it("returns an empty map when discounts is an empty array", () => {
    const m = mapDiscountsByUid(order([]));
    expect(m.size).toBe(0);
  });

  it("misses for an unknown uid", () => {
    const m = mapDiscountsByUid(order([discount("d1", "Happy Hour")]));
    expect(m.get("nope")).toBeUndefined();
  });

  it("last entry wins on duplicate uids", () => {
    const m = mapDiscountsByUid(order([discount("d1", "First"), discount("d1", "Second")]));
    expect(m.get("d1")).toBe("Second");
    expect(m.size).toBe(1);
  });

  it("returns a real Map instance", () => {
    const m = mapDiscountsByUid(order([]));
    expect(m).toBeInstanceOf(Map);
  });
});

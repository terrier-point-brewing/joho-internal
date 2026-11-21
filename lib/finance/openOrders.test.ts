import { describe, it, expect } from "vitest";
import { pickOpenOrderIds } from "./openOrders";

describe("pickOpenOrderIds", () => {
  it("keeps an order with a line no variation resolves, newest first, once", () => {
    const ids = pickOpenOrderIds(
      [
        { orderId: "may", transactionDate: "2026-05-16T22:00:00Z", variationId: null },
        { orderId: "june", transactionDate: "2026-06-09T22:00:00Z", variationId: "v-unmapped" },
        { orderId: "june", transactionDate: "2026-06-09T22:00:00Z", variationId: null },
      ],
      new Set(),
    );
    expect(ids).toEqual(["june", "may"]);
  });

  it("drops a line whose variation is mapped or excluded", () => {
    const ids = pickOpenOrderIds(
      [
        { orderId: "resolved", transactionDate: "2026-06-01T00:00:00Z", variationId: "v-mapped" },
        { orderId: "mixed", transactionDate: "2026-06-02T00:00:00Z", variationId: "v-mapped" },
        { orderId: "mixed", transactionDate: "2026-06-02T00:00:00Z", variationId: "v-other" },
      ],
      new Set(["v-mapped"]),
    );
    expect(ids).toEqual(["mixed"]);
  });

  it("orders same-instant orders by id so paging is stable", () => {
    const at = "2026-06-01T00:00:00Z";
    expect(pickOpenOrderIds([{ orderId: "b", transactionDate: at, variationId: null }, { orderId: "a", transactionDate: at, variationId: null }], new Set())).toEqual(["a", "b"]);
  });
});

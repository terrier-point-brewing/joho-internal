import { describe, it, expect } from "vitest";
import {
  orderTransactionDate,
  countSquareOrdersByDay,
  countDbOrdersByDay,
  diffDailyCounts,
} from "./gapScan";
import type { Order } from "@/types/square";

const TZ = "America/New_York";

// A real sale: it has something on it and money attached, so the sync persists
// it. Orders missing both are empty shells the sync drops — see the exclusion
// test below.
function order(overrides: Partial<Order> = {}): Order {
  return {
    id: "ORDER_1",
    location_id: "LOC_1",
    state: "COMPLETED",
    created_at: "2026-05-16T18:00:00Z",
    updated_at: "2026-05-16T18:05:00Z",
    closed_at: "2026-05-16T18:06:00Z",
    line_items: [{ uid: "li1", name: "Pint" }],
    total_money: { amount: 700, currency: "USD" },
    ...overrides,
  } as Order;
}

describe("orderTransactionDate", () => {
  it("prefers closed_at, matching buildOrderPayload's transaction_date", () => {
    expect(
      orderTransactionDate(
        order({ closed_at: "2026-05-16T18:06:00Z", updated_at: "2026-05-17T18:00:00Z" }),
        TZ,
      ),
    ).toBe("2026-05-16");
  });

  it("falls back to updated_at, then created_at", () => {
    expect(orderTransactionDate(order({ closed_at: undefined }), TZ)).toBe("2026-05-16");
    expect(
      orderTransactionDate(order({ closed_at: undefined, updated_at: undefined }), TZ),
    ).toBe("2026-05-16");
  });

  // 02:00 UTC on the 17th is still the evening of the 16th in the taproom. Both
  // sides must bucket on brewery-local days or every late shift reads as a gap.
  it("buckets a late-night order into the local day, not the UTC day", () => {
    expect(orderTransactionDate(order({ closed_at: "2026-05-17T02:00:00Z" }), TZ)).toBe("2026-05-16");
  });

  it("returns null when the order carries no timestamp at all", () => {
    expect(
      orderTransactionDate(
        order({ closed_at: undefined, updated_at: undefined, created_at: undefined }),
        TZ,
      ),
    ).toBeNull();
  });
});

describe("countSquareOrdersByDay", () => {
  it("counts orders per local day", () => {
    const counts = countSquareOrdersByDay(
      [
        order({ id: "a", closed_at: "2026-05-16T18:00:00Z" }),
        order({ id: "b", closed_at: "2026-05-16T19:00:00Z" }),
        order({ id: "c", closed_at: "2026-05-17T18:00:00Z" }),
      ],
      TZ,
    );
    expect(counts.get("2026-05-16")).toBe(2);
    expect(counts.get("2026-05-17")).toBe(1);
  });

  // The sync skips return orders, so counting them would show a shortfall on
  // every refund day and re-sync it forever without converging.
  it("excludes return orders, which the sync never persists", () => {
    const counts = countSquareOrdersByDay(
      [
        order({ id: "sale", closed_at: "2026-05-16T18:00:00Z" }),
        order({ id: "refund", closed_at: "2026-05-16T19:00:00Z", returns: [{ uid: "r1", source_order_id: "sale" }] }),
      ],
      TZ,
    );
    expect(counts.get("2026-05-16")).toBe(1);
  });

  // Same convergence trap as return orders: the sync drops a cash-drawer open
  // or an abandoned $0 ticket, so counting it here would strand the day.
  it("excludes empty shell orders, which the sync never persists", () => {
    const counts = countSquareOrdersByDay(
      [
        order({ id: "sale", closed_at: "2026-05-16T18:00:00Z" }),
        order({
          id: "no-sale",
          closed_at: "2026-05-16T19:00:00Z",
          line_items: undefined,
          total_money: { amount: 0, currency: "USD" },
        }),
      ],
      TZ,
    );
    expect(counts.get("2026-05-16")).toBe(1);
  });
});

describe("countDbOrdersByDay", () => {
  it("buckets transaction_date on local days and ignores null dates", () => {
    const counts = countDbOrdersByDay(
      [
        { transaction_date: "2026-05-16T18:00:00Z" },
        { transaction_date: "2026-05-17T02:00:00Z" }, // still the 16th locally
        { transaction_date: null },
      ],
      TZ,
    );
    expect(counts.get("2026-05-16")).toBe(2);
    expect(counts.size).toBe(1);
  });
});

describe("diffDailyCounts", () => {
  const days = ["2026-05-16", "2026-05-17", "2026-05-18"];

  it("flags a day Square has orders for but we don't", () => {
    const diff = diffDailyCounts(new Map([["2026-05-17", 12]]), new Map([["2026-05-17", 9]]), days);
    expect(diff.missing).toEqual([{ date: "2026-05-17", square: 12, db: 9 }]);
    expect(diff.surplus).toEqual([]);
  });

  it("reports a surplus separately — re-syncing cannot delete rows", () => {
    const diff = diffDailyCounts(new Map([["2026-05-17", 5]]), new Map([["2026-05-17", 8]]), days);
    expect(diff.missing).toEqual([]);
    expect(diff.surplus).toEqual([{ date: "2026-05-17", square: 5, db: 8 }]);
  });

  it("treats a day missing from both sides as agreement, not a gap", () => {
    const diff = diffDailyCounts(new Map(), new Map(), days);
    expect(diff.missing).toEqual([]);
    expect(diff.surplus).toEqual([]);
  });

  it("flags a day we have nothing at all for", () => {
    const diff = diffDailyCounts(new Map([["2026-05-18", 7]]), new Map(), days);
    expect(diff.missing).toEqual([{ date: "2026-05-18", square: 7, db: 0 }]);
  });

  it("reports matching days as neither missing nor surplus", () => {
    const counts = new Map([["2026-05-16", 4], ["2026-05-17", 11]]);
    const diff = diffDailyCounts(counts, new Map(counts), days);
    expect(diff.missing).toEqual([]);
    expect(diff.surplus).toEqual([]);
  });
});

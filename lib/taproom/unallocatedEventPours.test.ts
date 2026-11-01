import { describe, it, expect } from "vitest";
import { findOrphanPours, clusterOrphanPours, stretchedWindow, nearestEvent } from "./unallocatedEventPours";
import type { Order } from "@/types/square";

const TZ = "America/New_York";
const names = new Map([["EP1", "Pint"], ["EP2", "Half Pint"]]);

function order(id: string, closed: string, lines: [string, string, number][]): Order {
  return {
    id,
    closed_at: closed,
    line_items: lines.map(([varId, qty, gross]) => ({
      catalog_object_id: varId,
      quantity: qty,
      gross_sales_money: { amount: gross, currency: "USD" },
      total_discount_money: { amount: 0, currency: "USD" },
      total_tax_money: { amount: Math.round(gross * 0.07), currency: "USD" },
    })),
  } as unknown as Order;
}

const trivia = { id: "ev1", event_name: "Trivia", event_start: "2026-10-10T22:00:00Z", event_end: "2026-10-11T01:00:00Z" };

describe("findOrphanPours", () => {
  it("keeps Event Pour lines closed outside every event window and drops the rest", () => {
    const orders = [
      order("in", "2026-10-10T23:00:00Z", [["EP1", "2", 1400]]),          // inside Trivia
      order("late", "2026-10-11T01:30:00Z", [["EP1", "1", 700], ["TAP", "1", 600]]), // after Trivia ended
      order("none", "2026-10-11T01:40:00Z", [["TAP", "3", 1800]]),       // no event pour at all
    ];
    const out = findOrphanPours(orders, names, [trivia]);
    expect(out.map((p) => p.order_id)).toEqual(["late"]);
    expect(out[0]).toMatchObject({ variation_name: "Pint", quantity: 1, gross_cents: 700 });
  });

  it("ignores orders without a closed_at", () => {
    const o = order("open", "", [["EP1", "1", 700]]);
    expect(findOrphanPours([o], names, [])).toEqual([]);
  });
});

describe("clusterOrphanPours", () => {
  it("groups same-day pours within the gap and splits across a long gap or a new day", () => {
    const pours = findOrphanPours([
      order("a", "2026-10-12T20:00:00Z", [["EP1", "1", 700]]),
      order("b", "2026-10-12T20:30:00Z", [["EP2", "2", 800]]),
      order("c", "2026-10-13T20:00:00Z", [["EP1", "1", 700]]), // next local day
    ], names, []);
    const clusters = clusterOrphanPours(pours, [], TZ);
    expect(clusters).toHaveLength(2);
    // Newest first.
    expect(clusters[0].date).toBe("2026-10-13");
    expect(clusters[1]).toMatchObject({ date: "2026-10-12", order_count: 2, quantity: 3, gross_cents: 1500 });
    expect(clusters[1].rows.map((r) => r.variation_name)).toEqual(["Half Pint", "Pint"]);
  });

  it("splits pours more than the gap apart even on the same day", () => {
    const pours = findOrphanPours([
      order("a", "2026-10-12T16:00:00Z", [["EP1", "1", 700]]),
      order("b", "2026-10-12T21:00:00Z", [["EP1", "1", 700]]),
    ], names, []);
    expect(clusterOrphanPours(pours, [], TZ)).toHaveLength(2);
  });

  it("names the event whose window ended just before the cluster", () => {
    const pours = findOrphanPours([order("late", "2026-10-11T01:30:00Z", [["EP1", "1", 700]])], names, [trivia]);
    const [c] = clusterOrphanPours(pours, [trivia], TZ);
    expect(c.nearest_event?.id).toBe("ev1");
  });

  it("offers no event when none is within reach", () => {
    const pours = findOrphanPours([order("x", "2026-10-20T01:30:00Z", [["EP1", "1", 700]])], names, [trivia]);
    expect(clusterOrphanPours(pours, [trivia], TZ)[0].nearest_event).toBeNull();
  });
});

describe("nearestEvent", () => {
  it("picks the closest window edge", () => {
    const early = { id: "e", event_name: "E", event_start: "2026-10-10T18:00:00Z", event_end: "2026-10-10T20:00:00Z" };
    const t = new Date("2026-10-10T20:30:00Z").getTime();
    expect(nearestEvent(t, t, [trivia, early], 6 * 3600e3)?.id).toBe("e");
  });
});

describe("stretchedWindow", () => {
  it("extends only the side that needs it, with padding", () => {
    const w = stretchedWindow(trivia, { first_closed_at: "2026-10-11T01:30:00Z", last_closed_at: "2026-10-11T01:45:00Z" });
    expect(w.event_start).toBe("2026-10-10T22:00:00.000Z");
    expect(w.event_end).toBe("2026-10-11T02:00:00.000Z");
  });
});

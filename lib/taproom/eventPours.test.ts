import { describe, it, expect } from "vitest";
import { eventOrderIds } from "./eventPours";
import type { Order } from "@/types/square";

const ev = { event_start: "2026-07-16T22:00:00Z", event_end: "2026-07-17T01:00:00Z" };
const vars = new Set(["var-event"]);
type Line = NonNullable<Order["line_items"]>[number];
const order = (id: string, closed_at: string, li: Partial<Line>[], extra: Partial<Order> = {}) =>
  ({ id, closed_at, line_items: li as Line[], ...extra }) as Order;

describe("eventOrderIds", () => {
  it("claims an Event Pour order closed inside the buffered window, by catalog id or sale-time name", () => {
    const ids = eventOrderIds([
      order("a", "2026-07-16T21:30:00Z", [{ catalog_object_id: "var-event" }]),       // 30 min before start: inside the 1h buffer
      order("b", "2026-07-17T01:30:00Z", [{ catalog_object_id: "x", name: "Event Pour – Lager" }]),
      order("c", "2026-07-16T23:00:00Z", [{ catalog_object_id: "regular-tap" }]),     // in window, no event pour
      order("d", "2026-07-16T20:00:00Z", [{ catalog_object_id: "var-event" }]),       // too early
      order("e", "2026-07-16T23:00:00Z", [{ catalog_object_id: "var-event" }], { source: { name: "Invoices" } }),
    ], [ev], vars);
    expect([...ids].sort()).toEqual(["a", "b"]);
  });

  it("claims nothing when no event is listed", () => {
    expect(eventOrderIds([order("a", "2026-07-16T23:00:00Z", [{ catalog_object_id: "var-event" }])], [], vars).size).toBe(0);
  });
});

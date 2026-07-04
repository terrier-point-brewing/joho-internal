import { describe, it, expect } from "vitest";
import { detectKegSwaps, SWAP_THRESHOLD_FRACTION, type KegSwapEvent } from "./draftKegEvents";
import type { PhysicalCount } from "./inventory";

function count(id: string, quantity: number, occurredAt: string): PhysicalCount {
  return {
    id,
    catalog_object_id: "VAR1",
    catalog_object_type: "ITEM_VARIATION",
    state: "IN_STOCK",
    location_id: "LZ8TH4A632YW0",
    quantity: String(quantity),
    occurred_at: occurredAt,
    created_at: occurredAt,
  };
}

describe("detectKegSwaps", () => {
  it("emits one event for a single low→high crossing", () => {
    const counts = [
      count("a", 660, "2026-01-01T10:00:00Z"),
      count("b", 120, "2026-01-02T10:00:00Z"), // prev, still in keg at swap
      count("c", 655, "2026-01-03T10:00:00Z"), // crosses back up
    ];
    const events = detectKegSwaps(counts, 660);
    expect(events).toHaveLength(1);
    expect(events[0].physicalCountId).toBe("c");
    expect(events[0].remainingFlOz).toBe(120);
    expect(events[0].date).toBe("2026-01-03");
    expect(events[0].occurredAt).toBe("2026-01-03T10:00:00Z");
  });

  it("scales the threshold with fullVolumeFlOz (660)", () => {
    // threshold = 660 * 580/660 = 580
    const jumpTo600 = [
      count("a", 100, "2026-01-01T00:00:00Z"),
      count("b", 600, "2026-01-02T00:00:00Z"),
    ];
    expect(detectKegSwaps(jumpTo600, 660)).toHaveLength(1);

    const jumpTo500 = [
      count("a", 100, "2026-01-01T00:00:00Z"),
      count("b", 500, "2026-01-02T00:00:00Z"),
    ];
    expect(detectKegSwaps(jumpTo500, 660)).toHaveLength(0);
  });

  it("scales the threshold with fullVolumeFlOz (1980)", () => {
    // threshold = 1980 * 580/660 = 1740
    const jumpTo1800 = [
      count("a", 300, "2026-01-01T00:00:00Z"),
      count("b", 1800, "2026-01-02T00:00:00Z"),
    ];
    expect(detectKegSwaps(jumpTo1800, 1980)).toHaveLength(1);

    const jumpTo1000 = [
      count("a", 300, "2026-01-01T00:00:00Z"),
      count("b", 1000, "2026-01-02T00:00:00Z"),
    ];
    expect(detectKegSwaps(jumpTo1000, 1980)).toHaveLength(0);
  });

  it("detects multiple swaps across a longer series", () => {
    const counts = [
      count("a", 660, "2026-01-01T00:00:00Z"),
      count("b", 200, "2026-01-02T00:00:00Z"),
      count("c", 640, "2026-01-03T00:00:00Z"), // swap 1, remaining 200
      count("d", 80, "2026-01-04T00:00:00Z"),
      count("e", 650, "2026-01-05T00:00:00Z"), // swap 2, remaining 80
      count("f", 300, "2026-01-06T00:00:00Z"),
    ];
    const events = detectKegSwaps(counts, 660);
    expect(events.map((e: KegSwapEvent) => e.physicalCountId)).toEqual(["c", "e"]);
    expect(events.map((e: KegSwapEvent) => e.remainingFlOz)).toEqual([200, 80]);
  });

  it("emits nothing for a monotonic decline", () => {
    const counts = [
      count("a", 660, "2026-01-01T00:00:00Z"),
      count("b", 500, "2026-01-02T00:00:00Z"),
      count("c", 300, "2026-01-03T00:00:00Z"),
      count("d", 50, "2026-01-04T00:00:00Z"),
    ];
    expect(detectKegSwaps(counts, 660)).toHaveLength(0);
  });

  it("sorts unsorted input internally before detecting", () => {
    const counts = [
      count("c", 655, "2026-01-03T10:00:00Z"),
      count("a", 660, "2026-01-01T10:00:00Z"),
      count("b", 120, "2026-01-02T10:00:00Z"),
    ];
    const events = detectKegSwaps(counts, 660);
    expect(events).toHaveLength(1);
    expect(events[0].physicalCountId).toBe("c");
    expect(events[0].remainingFlOz).toBe(120);
  });

  it("rounds remainingFlOz to one decimal", () => {
    const counts = [
      count("a", 123.456, "2026-01-01T00:00:00Z"),
      count("b", 660, "2026-01-02T00:00:00Z"),
    ];
    expect(detectKegSwaps(counts, 660)[0].remainingFlOz).toBe(123.5);
  });

  it("exposes the 580/660 threshold fraction", () => {
    expect(SWAP_THRESHOLD_FRACTION).toBe(580 / 660);
  });
});

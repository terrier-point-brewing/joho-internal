// lib/production/shipLines.test.ts
import { describe, it, expect } from "vitest";
import { normalizeShipLines, dedupeWarnings } from "./shipLines";
import type { ShipmentWarning } from "@/lib/production/allocationReserve";

describe("normalizeShipLines", () => {
  it("keeps several variations of the same recipe as separate lines", () => {
    expect(normalizeShipLines({
      lines: [
        { variation_id: "half-keg", quantity: 2 },
        { variation_id: "sixth-keg", quantity: 3 },
      ],
    })).toEqual([
      { variation_id: "half-keg", quantity: 2 },
      { variation_id: "sixth-keg", quantity: 3 },
    ]);
  });

  it("sums duplicate variations so availability is checked against the total", () => {
    // The overdraw guard: 6 + 6 must be seen as 12, not as two independent 6s.
    expect(normalizeShipLines({
      lines: [
        { variation_id: "half-keg", quantity: 6 },
        { variation_id: "half-keg", quantity: 6 },
      ],
    })).toEqual([{ variation_id: "half-keg", quantity: 12 }]);
  });

  it("drops blank, zero, negative and non-numeric lines", () => {
    expect(normalizeShipLines({
      lines: [
        { variation_id: "", quantity: 5 },
        { variation_id: "a", quantity: 0 },
        { variation_id: "b", quantity: -3 },
        { variation_id: "c", quantity: "" },
        { variation_id: "d", quantity: "abc" },
        { variation_id: "e", quantity: "4" },
      ],
    })).toEqual([{ variation_id: "e", quantity: 4 }]);
  });

  it("accepts the single-line form", () => {
    expect(normalizeShipLines({ variation_id: "half-keg", quantity: 2 }))
      .toEqual([{ variation_id: "half-keg", quantity: 2 }]);
  });

  it("prefers lines[] over the single-line fields when both are present", () => {
    expect(normalizeShipLines({
      lines: [{ variation_id: "a", quantity: 1 }],
      variation_id: "b", quantity: 9,
    })).toEqual([{ variation_id: "a", quantity: 1 }]);
  });

  it("returns nothing for an empty or unusable request", () => {
    expect(normalizeShipLines({})).toEqual([]);
    expect(normalizeShipLines({ lines: [] })).toEqual([]);
    expect(normalizeShipLines({ lines: [{ variation_id: "a", quantity: 0 }] })).toEqual([]);
  });
});

describe("dedupeWarnings", () => {
  const w = (kind: string, extra: Record<string, unknown> = {}) =>
    ({ kind, ...extra }) as unknown as ShipmentWarning;

  it("collapses identical warnings raised by different lines", () => {
    expect(dedupeWarnings([w("over_delivery"), w("over_delivery")]))
      .toEqual([w("over_delivery")]);
  });

  it("keeps warnings that differ in any field", () => {
    const list = [w("over_delivery", { bbl: 1 }), w("over_delivery", { bbl: 2 })];
    expect(dedupeWarnings(list)).toHaveLength(2);
  });

  it("preserves first-appearance order", () => {
    const list = [w("a"), w("b"), w("a"), w("c")];
    expect(dedupeWarnings(list).map((x) => (x as unknown as { kind: string }).kind))
      .toEqual(["a", "b", "c"]);
  });

  it("handles an empty list", () => {
    expect(dedupeWarnings([])).toEqual([]);
  });
});

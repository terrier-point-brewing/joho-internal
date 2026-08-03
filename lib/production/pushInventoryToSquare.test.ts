import { describe, it, expect } from "vitest";
import { selectPushable } from "./pushInventoryToSquare";
import { PUSH_TO_SQUARE_ENABLED, DRIFT_THRESHOLD } from "@/lib/square/pushGate";

describe("selectPushable", () => {
  it("keeps drift at or above the threshold", () => {
    expect(selectPushable([{ drift: 1 }, { drift: -3 }], 0.5)).toEqual([{ drift: 1 }, { drift: -3 }]);
  });

  // Fractional drift is rounding and in-flight sales. Writing it would put the
  // app in a permanent tug-of-war with Square over half a can.
  it("drops drift below the threshold in both directions", () => {
    expect(selectPushable([{ drift: 0.4 }, { drift: -0.4 }, { drift: 0 }], 0.5)).toEqual([]);
  });

  it("treats the threshold itself as pushable", () => {
    expect(selectPushable([{ drift: 0.5 }, { drift: -0.5 }], 0.5)).toHaveLength(2);
  });

  it("defaults to the shared threshold", () => {
    expect(selectPushable([{ drift: DRIFT_THRESHOLD }])).toHaveLength(1);
    expect(selectPushable([{ drift: DRIFT_THRESHOLD / 2 }])).toEqual([]);
  });

  it("returns nothing for no measurements", () => {
    expect(selectPushable([])).toEqual([]);
  });
});

describe("push gate", () => {
  // A deliberate tripwire. Flipping this on makes cold storage overwrite Square
  // across every mapped SKU, and the two sides are known to disagree on beers
  // nobody has adjudicated yet. If this test fails, that decision is being made
  // — make sure it is being made on purpose.
  it("is shut", () => {
    expect(PUSH_TO_SQUARE_ENABLED).toBe(false);
  });
});

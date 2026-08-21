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
  // Still a deliberate tripwire, now pointing the other way. It was shut from
  // 2026-08-03 until 2026-08-20, held by this test while seventeen drifting SKUs
  // went unadjudicated; it opened once a person had ruled on every one of them
  // and the drift measured zero across all 61 mapped SKUs.
  //
  // If this test fails, someone is shutting the push off again. That is a real
  // decision, not a cleanup: while it is shut, packaging runs stop reaching
  // Square but sales and invoices keep deducting, so Square drifts low and
  // eventually negative — which is precisely how it got to −15 Pace Yourself
  // 1/6 kegs the last time. Shut it deliberately, and re-open it deliberately.
  it("is open", () => {
    expect(PUSH_TO_SQUARE_ENABLED).toBe(true);
  });
});

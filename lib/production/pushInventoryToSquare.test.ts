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
  // A deliberate tripwire, pointing whichever way the gate currently sits, so
  // that moving it is always an edit someone has to justify. Open 2026-08-20 to
  // 2026-08-31; shut before that from 2026-08-03.
  //
  // Shut on 2026-08-31 after a physical count entered into the Square Dashboard
  // was reversed by the push within hours, and re-opened on 2026-09-01 once cold
  // storage had been trued to that count (#521) and the loose-tier blind spot
  // that hid 684 cans was fixed. The read-back before the flip showed every
  // planned write moving Square toward the count.
  //
  // If this test fails, someone is shutting the push off again. That is a real
  // decision, not a cleanup: while it is shut, packaging runs stop reaching
  // Square but sales and invoices keep deducting, so Square drifts low and
  // eventually negative — which is precisely how it got to −15 Pace Yourself
  // 1/6 kegs during the August closure. Shut it deliberately, and re-open it
  // deliberately.
  //
  // The one case where shutting it IS right: before a physical count. Until the
  // app can record a count itself, a count goes into Square, and an open gate
  // will erase it.
  it("is open", () => {
    expect(PUSH_TO_SQUARE_ENABLED).toBe(true);
  });
});

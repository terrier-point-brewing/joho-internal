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
  // Shut again on 2026-08-31: a physical count of the cold room was entered into
  // the Square Dashboard — the only place there is to put one — and the push
  // reversed all 23 lines within hours. It also emerged that the reconciler
  // cannot see a can family whose loose tier is at zero, which hid 684 cans and
  // made Epic Hazy push 2 against 330 on hand.
  //
  // If this test fails, someone is re-opening the push. That is a real decision,
  // not a cleanup, and it has a cost in BOTH directions. While it is shut,
  // packaging runs stop reaching Square but sales and invoices keep deducting,
  // so Square drifts low and eventually negative — which is how it got to −15
  // Pace Yourself 1/6 kegs last time. So do not leave it shut indefinitely
  // either: fix cold storage, fix the loose-tier blind spot, then re-open.
  it("is shut", () => {
    expect(PUSH_TO_SQUARE_ENABLED).toBe(false);
  });
});

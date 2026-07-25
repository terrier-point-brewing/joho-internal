// Pairing queued tap swaps to bartender-rung Draft Restock line events.
//
// A queued swap is a frozen note ("tap 3 goes Beer A → Beer B"); the ring is what
// books it. Pairing is FIFO per tap and must be DETERMINISTIC — two sync runs over
// the same window have to agree, or a swap gets booked twice against different
// events.
import { describe, it, expect } from "vitest";
import {
  pairSwapsToRestocks,
  restockEventKey,
  staleSwaps,
  type PendingTapSwap,
} from "./tapSwaps";

const swap = (over: Partial<PendingTapSwap> = {}): PendingTapSwap => ({
  id: "swap-1",
  tapNumber: 3,
  fromRecipeId: "recipe-a",
  fromBeerName: "Vienna Lager",
  fromVariationId: "pv-a",
  fromVolumeFlOz: 1984,
  fromDraftSquareVariationId: "sq-draft-a",
  toRecipeId: "recipe-b",
  toBeerName: "Hazy IPA",
  toVariationId: "pv-b",
  toVolumeFlOz: 661,
  toDraftSquareVariationId: "sq-draft-b",
  openedAt: "2026-07-20T15:00:00.000Z",
  ...over,
});

const event = (over: Partial<{ orderId: string; lineUid: string; squareVariationId: string; occurredAt: string }> = {}) => ({
  orderId: "ord-1",
  lineUid: "line-1",
  squareVariationId: "sq-restock-tap3",
  occurredAt: "2026-07-21T20:00:00.000Z",
  ...over,
});

// Square restock variation → tap number. Tap 3 and tap 5 each have their own
// $0 Draft Restock variation.
const TAP_BY_VAR = new Map([
  ["sq-restock-tap3", 3],
  ["sq-restock-tap5", 5],
]);

describe("restockEventKey", () => {
  it("keys on order + line uid", () => {
    expect(restockEventKey("ord-1", "line-1")).toBe("ord-1:line-1");
  });

  it("distinguishes two lines on one order", () => {
    expect(restockEventKey("ord-1", "line-1")).not.toBe(restockEventKey("ord-1", "line-2"));
  });
});

describe("pairSwapsToRestocks", () => {
  it("pairs one event to one queued swap on the same tap", () => {
    const s = swap();
    const paired = pairSwapsToRestocks([event()], TAP_BY_VAR, [s]);
    expect(paired.get("ord-1:line-1")).toBe(s);
  });

  it("gives the swap to the EARLIEST event when two rings arrive for one swap", () => {
    // Only one keg physically changed, so only the first ring is the swap; the
    // second is a like-for-like restock of the incoming beer.
    const s = swap();
    const later = event({ lineUid: "line-late", occurredAt: "2026-07-21T22:00:00.000Z" });
    const earlier = event({ lineUid: "line-early", occurredAt: "2026-07-21T18:00:00.000Z" });
    const paired = pairSwapsToRestocks([later, earlier], TAP_BY_VAR, [s]);
    expect(paired.get("ord-1:line-early")).toBe(s);
    expect(paired.has("ord-1:line-late")).toBe(false);
  });

  it("consumes the OLDEST swap when two are queued on one tap", () => {
    const older = swap({ id: "swap-old", openedAt: "2026-07-19T10:00:00.000Z" });
    const newer = swap({ id: "swap-new", openedAt: "2026-07-20T10:00:00.000Z" });
    const paired = pairSwapsToRestocks([event()], TAP_BY_VAR, [newer, older]);
    expect(paired.get("ord-1:line-1")).toBe(older);
  });

  it("zips several events and swaps on one tap in order", () => {
    const s1 = swap({ id: "s1", openedAt: "2026-07-19T10:00:00.000Z" });
    const s2 = swap({ id: "s2", openedAt: "2026-07-20T10:00:00.000Z" });
    const e1 = event({ lineUid: "e1", occurredAt: "2026-07-19T12:00:00.000Z" });
    const e2 = event({ lineUid: "e2", occurredAt: "2026-07-20T12:00:00.000Z" });
    const paired = pairSwapsToRestocks([e2, e1], TAP_BY_VAR, [s2, s1]);
    expect(paired.get("ord-1:e1")).toBe(s1);
    expect(paired.get("ord-1:e2")).toBe(s2);
  });

  it("never pairs a swap on tap 3 with an event on tap 5", () => {
    const s = swap({ tapNumber: 3 });
    const tap5Event = event({ lineUid: "line-5", squareVariationId: "sq-restock-tap5" });
    const paired = pairSwapsToRestocks([tap5Event], TAP_BY_VAR, [s]);
    expect(paired.size).toBe(0);
  });

  it("ignores an event whose restock variation maps to no tap", () => {
    const paired = pairSwapsToRestocks(
      [event({ squareVariationId: "sq-unmapped" })], TAP_BY_VAR, [swap()],
    );
    expect(paired.size).toBe(0);
  });

  it("breaks equal-timestamp ties deterministically", () => {
    // Same openedAt / occurredAt: pairing must not depend on input array order,
    // or two sync runs can disagree and double-book.
    const sA = swap({ id: "aaa", openedAt: "2026-07-20T10:00:00.000Z" });
    const sB = swap({ id: "bbb", openedAt: "2026-07-20T10:00:00.000Z" });
    const eA = event({ lineUid: "aaa" });
    const eB = event({ lineUid: "bbb" });

    const forward = pairSwapsToRestocks([eA, eB], TAP_BY_VAR, [sA, sB]);
    const reversed = pairSwapsToRestocks([eB, eA], TAP_BY_VAR, [sB, sA]);

    expect(forward.get("ord-1:aaa")).toBe(sA);
    expect(forward.get("ord-1:bbb")).toBe(sB);
    expect(reversed.get("ord-1:aaa")?.id).toBe("aaa");
    expect(reversed.get("ord-1:bbb")?.id).toBe("bbb");
  });

  it("returns an empty map for empty inputs", () => {
    expect(pairSwapsToRestocks([], TAP_BY_VAR, []).size).toBe(0);
    expect(pairSwapsToRestocks([event()], TAP_BY_VAR, []).size).toBe(0);
    expect(pairSwapsToRestocks([], TAP_BY_VAR, [swap()]).size).toBe(0);
  });
});

describe("staleSwaps", () => {
  const NOW = "2026-07-24T12:00:00.000Z";

  it("flags an unpaired swap older than the max age", () => {
    const s = swap({ openedAt: "2026-07-14T12:00:00.000Z" }); // 10 days
    expect(staleSwaps([s], new Map(), NOW, 7)).toEqual([s]);
  });

  it("does not flag an old swap that a ring consumed this run", () => {
    const s = swap({ openedAt: "2026-07-14T12:00:00.000Z" });
    const paired = new Map([["ord-1:line-1", s]]);
    expect(staleSwaps([s], paired, NOW, 7)).toEqual([]);
  });

  it("does not flag a recent unpaired swap", () => {
    const s = swap({ openedAt: "2026-07-22T12:00:00.000Z" }); // 2 days
    expect(staleSwaps([s], new Map(), NOW, 7)).toEqual([]);
  });

  it("treats exactly-at-the-boundary as not yet stale", () => {
    const s = swap({ openedAt: "2026-07-17T12:00:00.000Z" }); // exactly 7 days
    expect(staleSwaps([s], new Map(), NOW, 7)).toEqual([]);
  });
});

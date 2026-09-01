import { describe, it, expect } from "vitest";
import { tapBookingGaps, allTapBookingGaps, type TapBookingInput } from "./draftBookingGap";

const SIXTEL = 661;

const tap = (over: Partial<TapBookingInput> = {}): TapBookingInput => ({
  tapNumber: 1,
  beerName: "Test Beer",
  lastRestockAt: "2026-08-20T00:00:00Z",
  pouredSinceRestockFlOz: 0,
  pouredEverFlOz: 0,
  swapKegFlOz: SIXTEL,
  swapKegsOnHand: 5,
  ...over,
});

describe("tapBookingGaps", () => {
  it("says nothing about a tap that is pouring normally", () => {
    expect(tapBookingGaps(tap({ pouredSinceRestockFlOz: 400, pouredEverFlOz: 4000 }))).toEqual([]);
  });

  // Coffee Epic on 2026-08-31: 900 fl oz poured, zero restocks ever rung.
  it("flags a tap that has poured with no restock ever rung", () => {
    const gaps = tapBookingGaps(tap({
      beerName: "Coffee Epic", lastRestockAt: null,
      pouredEverFlOz: 900, pouredSinceRestockFlOz: 900,
    }));
    expect(gaps.map((g) => g.kind)).toEqual(["never_booked"]);
    expect(gaps[0].unbookedKegs).toBe(1);
    expect(gaps[0].detail).toContain("900 fl oz");
  });

  // Transfusion Pilsner, same day: only 212 fl oz. A full-keg threshold would
  // have missed it entirely, which is why never_booked has no volume floor.
  it("flags a never-restocked tap below a full keg", () => {
    const gaps = tapBookingGaps(tap({
      beerName: "Transfusion Pilsner", lastRestockAt: null,
      pouredEverFlOz: 212, pouredSinceRestockFlOz: 212,
    }));
    expect(gaps.map((g) => g.kind)).toEqual(["never_booked"]);
    expect(gaps[0].unbookedKegs).toBe(1);
  });

  it("does not flag a never-restocked tap that has poured nothing", () => {
    expect(tapBookingGaps(tap({ lastRestockAt: null, pouredEverFlOz: 0 }))).toEqual([]);
  });

  // A real keg never pours its full volume — foam, line loss, the heel. Holding
  // the threshold at a WHOLE keg is what stops this firing on a correct booking.
  it("does not flag a tap that poured almost a full keg since its restock", () => {
    expect(tapBookingGaps(tap({ pouredSinceRestockFlOz: SIXTEL - 1 }))).toEqual([]);
    expect(tapBookingGaps(tap({ pouredSinceRestockFlOz: SIXTEL }))).toEqual([]);
  });

  it("flags one unbooked keg once a full keg has poured beyond the ring", () => {
    const gaps = tapBookingGaps(tap({ pouredSinceRestockFlOz: SIXTEL + 1 }));
    expect(gaps.map((g) => g.kind)).toEqual(["unbooked_kegs"]);
    expect(gaps[0].unbookedKegs).toBe(1);
    expect(gaps[0].detail).toContain("a full keg");
  });

  it("counts multiple unbooked kegs", () => {
    const gaps = tapBookingGaps(tap({ pouredSinceRestockFlOz: SIXTEL * 3 + 10 }));
    expect(gaps[0].unbookedKegs).toBe(3);
    expect(gaps[0].detail).toContain("3 full kegs");
  });

  it("never reports both never_booked and unbooked_kegs for one tap", () => {
    const gaps = tapBookingGaps(tap({
      lastRestockAt: null, pouredEverFlOz: SIXTEL * 4, pouredSinceRestockFlOz: SIXTEL * 4,
    }));
    expect(gaps.filter((g) => g.kind !== "no_keg_to_draw")).toHaveLength(1);
    expect(gaps[0].kind).toBe("never_booked");
  });

  // Coffee Epic again: tap 5 draws a 1/6 Keg, and the only Coffee Epic in cold
  // storage is a 1/2 Keg. The ring would find nothing to draw.
  it("warns when the tap's swap keg is out of stock", () => {
    const gaps = tapBookingGaps(tap({ swapKegsOnHand: 0 }));
    expect(gaps.map((g) => g.kind)).toEqual(["no_keg_to_draw"]);
  });

  it("reports an out-of-stock swap keg alongside an unbooked keg", () => {
    const gaps = tapBookingGaps(tap({ pouredSinceRestockFlOz: SIXTEL * 2, swapKegsOnHand: 0 }));
    expect(gaps.map((g) => g.kind)).toEqual(["unbooked_kegs", "no_keg_to_draw"]);
  });

  it("handles a tap with no swap keg configured without dividing by zero", () => {
    const gaps = tapBookingGaps(tap({
      swapKegFlOz: null, swapKegsOnHand: 0, lastRestockAt: null, pouredEverFlOz: 500,
    }));
    expect(gaps.map((g) => g.kind)).toEqual(["never_booked", "no_keg_to_draw"]);
    expect(gaps[0].unbookedKegs).toBe(1);
  });
});

describe("allTapBookingGaps", () => {
  it("flattens across taps and keeps them in tap order", () => {
    const gaps = allTapBookingGaps([
      tap({ tapNumber: 1 }),
      tap({ tapNumber: 5, beerName: "Coffee Epic", lastRestockAt: null, pouredEverFlOz: 900, swapKegsOnHand: 0 }),
      tap({ tapNumber: 7, beerName: "Groundhog", swapKegsOnHand: 0 }),
    ]);
    expect(gaps.map((g) => [g.tapNumber, g.kind])).toEqual([
      [5, "never_booked"],
      [5, "no_keg_to_draw"],
      [7, "no_keg_to_draw"],
    ]);
  });
});

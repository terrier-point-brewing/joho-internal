// lib/square/taproomConsumption.test.ts
//
// Unit tests for the PURE assembler. It maps Square keg/can sales (per variation
// per day) into keg_sale/can_sale units, and bartender-rung "Draft Restock" line
// items into draft_swap units — resolving each restock's swap keg + recount from
// its tap. Unmapped / unconfigured restocks surface as discrepancies; nothing is
// inferred from physical-count crossings anymore.
import { describe, it, expect } from "vitest";
import { assembleConsumption, trailingWindow, type KegCanLink, type DraftLink, type TapRestockLink } from "./taproomConsumption";
import type { RestockLineEvent } from "./inventory";
import type { PendingTapSwap } from "@/lib/taproom/tapSwaps";

describe("trailingWindow", () => {
  it("ends at now so same-day orders are inside the window", () => {
    const now = new Date("2026-07-05T19:44:00.000Z");
    const { startIso, endIso } = trailingWindow(now, 1);
    expect(endIso).toBe("2026-07-05T19:44:00.000Z"); // includes today up to now, not today-00:00
    expect(startIso).toBe("2026-07-04T00:00:00.000Z"); // UTC day boundary, 1 day back
  });

  it("widens the start with more days", () => {
    const { startIso } = trailingWindow(new Date("2026-07-05T12:00:00.000Z"), 2);
    expect(startIso).toBe("2026-07-03T00:00:00.000Z");
  });
});

const kegLink: KegCanLink = {
  squareVariationId: "sqvar-keg",
  recipeId: "recipe-keg",
  variationId: "pv-keg",
  kind: "keg_sale",
  beerName: "Porter",
  variationName: "1/6 BBL Keg",
};

const canLink: KegCanLink = {
  squareVariationId: "sqvar-can",
  recipeId: "recipe-can",
  variationId: "pv-can",
  kind: "can_sale",
  beerName: "Hazy IPA",
  variationName: "16oz 4-pack",
};

function empty() {
  return {
    salesByDay: new Map<string, number>(),
    kegCanLinks: [] as KegCanLink[],
    draftLinks: [] as DraftLink[],
  };
}

describe("assembleConsumption — keg/can sales", () => {
  it("maps a keg sale to a keg_sale unit with the right sourceRef", () => {
    const { units, discrepancies } = assembleConsumption({
      ...empty(),
      salesByDay: new Map([["sqvar-keg\t2026-07-01", 3]]),
      kegCanLinks: [kegLink],
    });

    expect(discrepancies).toEqual([]);
    expect(units).toHaveLength(1);
    expect(units[0]).toEqual({
      recipeId: "recipe-keg",
      variationId: "pv-keg",
      quantity: 3,
      sourceRef: "sqsale:sqvar-keg:2026-07-01",
      kind: "keg_sale",
      label: "Porter · 1/6 BBL Keg · 2026-07-01",
    });
  });

  it("maps a can sale to a can_sale unit", () => {
    const { units } = assembleConsumption({
      ...empty(),
      salesByDay: new Map([["sqvar-can\t2026-07-02", 5]]),
      kegCanLinks: [canLink],
    });

    expect(units).toHaveLength(1);
    expect(units[0].kind).toBe("can_sale");
    expect(units[0].sourceRef).toBe("sqsale:sqvar-can:2026-07-02");
    expect(units[0].quantity).toBe(5);
  });

  it("skips sales for an unknown square variation id", () => {
    const { units, discrepancies } = assembleConsumption({
      ...empty(),
      salesByDay: new Map([["sqvar-unknown\t2026-07-01", 2]]),
      kegCanLinks: [kegLink],
    });

    expect(units).toEqual([]);
    expect(discrepancies).toEqual([]);
  });
});

const draftLink: DraftLink = { squareVariationId: "draft-sqvar", recipeId: "recipe-1", beerName: "Vienna Lager" };

const tapLink = (over: Partial<TapRestockLink> = {}): TapRestockLink => ({
  restockVariationId: "restock-tap3",
  tapNumber: 3,
  recipeId: "recipe-1",
  beerName: "Vienna Lager",
  swapVariationId: "pv-keg-1",
  swapVolumeFlOz: 660,
  ...over,
});

const restockEvent = (over: Partial<RestockLineEvent> = {}): RestockLineEvent => ({
  orderId: "ord-1",
  lineUid: "line-1",
  squareVariationId: "restock-tap3",
  quantity: 1,
  occurredAt: "2026-07-04T20:00:00Z",
  ...over,
});

describe("assembleConsumption — sales with nowhere to book them", () => {
  // The Epic Hazy failure in miniature: Square deleted and recreated the
  // variation, the link kept pointing at the dead id, and sales arrived on the
  // live one. ~93 cans left the building and nothing said a word.
  it("reports a sale on a variation that should have been mapped", () => {
    const { units, discrepancies } = assembleConsumption({
      ...empty(),
      salesByDay: new Map([["sqvar-orphan\t2026-07-01", 23]]),
      kegCanLinks: [canLink],
      unmappedSaleCandidates: new Set(["sqvar-orphan"]),
    });

    expect(units).toEqual([]);
    expect(discrepancies).toEqual([
      { kind: "unmapped_sale", squareVariationId: "sqvar-orphan", quantity: 23, days: ["2026-07-01"] },
    ]);
  });

  it("accumulates one discrepancy per variation across days", () => {
    const { discrepancies } = assembleConsumption({
      ...empty(),
      salesByDay: new Map([
        ["sqvar-orphan\t2026-07-01", 2],
        ["sqvar-orphan\t2026-07-03", 5],
      ]),
      unmappedSaleCandidates: new Set(["sqvar-orphan"]),
    });

    expect(discrepancies).toEqual([
      { kind: "unmapped_sale", squareVariationId: "sqvar-orphan", quantity: 7, days: ["2026-07-01", "2026-07-03"] },
    ]);
  });

  // Narrowing is what makes this reportable rather than noise: every burger and
  // cocktail sold is an "unmapped" variation too.
  it("stays silent for a variation that was never a candidate", () => {
    const { units, discrepancies } = assembleConsumption({
      ...empty(),
      salesByDay: new Map([["sqvar-burger\t2026-07-01", 40]]),
      unmappedSaleCandidates: new Set(["sqvar-orphan"]),
    });

    expect(units).toEqual([]);
    expect(discrepancies).toEqual([]);
  });

  it("keeps the old silent behaviour when no candidate set is supplied", () => {
    const { discrepancies } = assembleConsumption({
      ...empty(),
      salesByDay: new Map([["sqvar-orphan\t2026-07-01", 9]]),
    });
    expect(discrepancies).toEqual([]);
  });

  it("does not report a variation that IS mapped", () => {
    const { units, discrepancies } = assembleConsumption({
      ...empty(),
      salesByDay: new Map([["sqvar-can\t2026-07-01", 4]]),
      kegCanLinks: [canLink],
      unmappedSaleCandidates: new Set(["sqvar-can"]),
    });

    expect(units).toHaveLength(1);
    expect(discrepancies).toEqual([]);
  });
});

describe("assembleConsumption — restock draft swaps (tap grain)", () => {
  it("maps a restock line to a draft_swap unit with the tap's swap keg + recount", () => {
    const { units, discrepancies } = assembleConsumption({
      ...empty(),
      draftLinks: [draftLink],
      restockEvents: [restockEvent()],
      tapRestockLinks: [tapLink()],
    });
    expect(discrepancies).toHaveLength(0);
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({
      recipeId: "recipe-1",
      variationId: "pv-keg-1",
      kind: "draft_swap",
      sourceRef: "sqtransfer:ord-1:line-1",
      tapNumber: 3,
      recount: { squareVariationId: "draft-sqvar", quantity: 660, occurredAt: "2026-07-04T20:00:00Z" },
    });
  });

  it("flags an unconfigured swap when the tap has no swap keg", () => {
    const { units, discrepancies } = assembleConsumption({
      ...empty(),
      draftLinks: [draftLink],
      restockEvents: [restockEvent()],
      tapRestockLinks: [tapLink({ swapVariationId: null })],
    });
    expect(units).toHaveLength(0);
    expect(discrepancies).toContainEqual(
      expect.objectContaining({ kind: "unconfigured_draft_swap", recipeId: "recipe-1", swapCount: 1 }),
    );
  });

  it("flags an unmapped restock when the variation maps to no tap", () => {
    const { units, discrepancies } = assembleConsumption({
      ...empty(),
      restockEvents: [restockEvent({ squareVariationId: "restock-unknown" })],
      tapRestockLinks: [tapLink()],
    });
    expect(units).toHaveLength(0);
    expect(discrepancies).toContainEqual(
      expect.objectContaining({ kind: "unmapped_restock", squareVariationId: "restock-unknown", count: 1 }),
    );
  });

  it("omits the recount when the recipe has no draft Square link", () => {
    const { units } = assembleConsumption({
      ...empty(),
      draftLinks: [],
      restockEvents: [restockEvent()],
      tapRestockLinks: [tapLink()],
    });
    expect(units[0].recount).toBeUndefined();
  });
});

// ─── Queued beer-change swaps ────────────────────────────────────────────────
//
// When a queued tap_swap_transitions row is paired to a ring, the unit's recipe,
// keg and recount target come from the FROZEN transition — never from the tap
// row, which by then may have been edited. Unpaired rings keep resolving off the
// tap row exactly as before.

const pendingSwap = (over: Partial<PendingTapSwap> = {}): PendingTapSwap => ({
  id: "swap-1",
  tapNumber: 3,
  fromRecipeId: "recipe-1",
  fromBeerName: "Vienna Lager",
  fromVariationId: "pv-keg-1",
  fromVolumeFlOz: 660,
  fromDraftSquareVariationId: "draft-sqvar",
  toRecipeId: "recipe-2",
  toBeerName: "Hazy IPA",
  toVariationId: "pv-keg-2",
  toVolumeFlOz: 661,
  toDraftSquareVariationId: "draft-sqvar-2",
  openedAt: "2026-07-04T15:00:00Z",
  ...over,
});

describe("assembleConsumption — queued swap transitions", () => {
  it("takes recipe, keg and recount from the transition, not the tap row", () => {
    const { units, discrepancies } = assembleConsumption({
      ...empty(),
      draftLinks: [draftLink],
      restockEvents: [restockEvent()],
      tapRestockLinks: [tapLink()],
      pendingSwaps: [pendingSwap()],
    });
    expect(discrepancies).toHaveLength(0);
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({
      recipeId: "recipe-2",      // incoming, NOT the tap row's recipe-1
      variationId: "pv-keg-2",   // incoming keg
      kind: "draft_swap",
      sourceRef: "sqtransfer:ord-1:line-1",
      tapNumber: 3,
      recount: { squareVariationId: "draft-sqvar-2", quantity: 661, occurredAt: "2026-07-04T20:00:00Z" },
    });
    expect(units[0].swap?.id).toBe("swap-1");
  });

  it("labels the unit with the incoming beer", () => {
    const { units } = assembleConsumption({
      ...empty(),
      draftLinks: [draftLink],
      restockEvents: [restockEvent()],
      tapRestockLinks: [tapLink()],
      pendingSwaps: [pendingSwap()],
    });
    expect(units[0].label).toContain("Hazy IPA");
    expect(units[0].label).not.toContain("Vienna Lager");
  });

  it("leaves an unpaired ring resolving off the tap row", () => {
    // Swap queued on tap 5, ring on tap 3 — the tap 3 ring is a plain restock.
    const { units } = assembleConsumption({
      ...empty(),
      draftLinks: [draftLink],
      restockEvents: [restockEvent()],
      tapRestockLinks: [tapLink()],
      pendingSwaps: [pendingSwap({ tapNumber: 5 })],
    });
    expect(units[0]).toMatchObject({ recipeId: "recipe-1", variationId: "pv-keg-1" });
    expect(units[0].swap).toBeUndefined();
  });

  it("still emits a unit when the incoming recipe has no draft Square link", () => {
    const { units } = assembleConsumption({
      ...empty(),
      draftLinks: [draftLink],
      restockEvents: [restockEvent()],
      tapRestockLinks: [tapLink()],
      pendingSwaps: [pendingSwap({ toDraftSquareVariationId: null })],
    });
    expect(units).toHaveLength(1);
    expect(units[0].recount).toBeUndefined();
    expect(units[0].swap?.id).toBe("swap-1");
  });

  it("carries the ring's quantity through to the incoming keg", () => {
    const { units } = assembleConsumption({
      ...empty(),
      draftLinks: [draftLink],
      restockEvents: [restockEvent({ quantity: 2 })],
      tapRestockLinks: [tapLink()],
      pendingSwaps: [pendingSwap()],
    });
    expect(units[0].quantity).toBe(2);
  });

  it("resolves off the transition even when the tap row has no swap keg", () => {
    // The tap row is mid-edit / never configured, but the frozen transition has
    // everything needed — so this must NOT flag unconfigured_draft_swap.
    const { units, discrepancies } = assembleConsumption({
      ...empty(),
      draftLinks: [draftLink],
      restockEvents: [restockEvent()],
      tapRestockLinks: [tapLink({ swapVariationId: null, swapVolumeFlOz: null })],
      pendingSwaps: [pendingSwap()],
    });
    expect(units).toHaveLength(1);
    expect(units[0].variationId).toBe("pv-keg-2");
    expect(discrepancies).toHaveLength(0);
  });

  it("flags a stale unpaired swap when nowIso is supplied", () => {
    const { discrepancies } = assembleConsumption({
      ...empty(),
      draftLinks: [draftLink],
      restockEvents: [],
      tapRestockLinks: [tapLink()],
      pendingSwaps: [pendingSwap({ openedAt: "2026-07-01T00:00:00Z" })],
      nowIso: "2026-07-24T00:00:00Z",
    });
    expect(discrepancies).toContainEqual(
      expect.objectContaining({
        kind: "stale_queued_swap", tapNumber: 3, swapId: "swap-1", toBeerName: "Hazy IPA",
      }),
    );
  });

  it("emits no staleness when nowIso is omitted", () => {
    const { discrepancies } = assembleConsumption({
      ...empty(),
      draftLinks: [draftLink],
      restockEvents: [],
      tapRestockLinks: [tapLink()],
      pendingSwaps: [pendingSwap({ openedAt: "2026-07-01T00:00:00Z" })],
    });
    expect(discrepancies).toHaveLength(0);
  });
});

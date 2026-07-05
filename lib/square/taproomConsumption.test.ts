// lib/square/taproomConsumption.test.ts
//
// Unit tests for the PURE assembler. It maps Square keg/can sales (per variation
// per day) into keg_sale/can_sale units, and bartender-rung "Draft Restock" line
// items into draft_swap units — resolving each restock's swap keg + recount from
// its tap. Unmapped / unconfigured restocks surface as discrepancies; nothing is
// inferred from physical-count crossings anymore.
import { describe, it, expect } from "vitest";
import { assembleConsumption, type KegCanLink, type DraftLink, type TapRestockLink } from "./taproomConsumption";
import type { RestockLineEvent } from "./inventory";

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

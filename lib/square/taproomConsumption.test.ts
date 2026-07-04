// lib/square/taproomConsumption.test.ts
//
// Unit tests for the PURE assembler. It maps Square keg/can sales (per variation
// per day) into keg_sale/can_sale units, and draft physical-count series into
// draft_swap units — using the real detectKegSwaps threshold logic — while
// surfacing unconfigured-swap discrepancies for draft recipes lacking a complete
// swap config.
import { describe, it, expect } from "vitest";
import { assembleConsumption, type KegCanLink, type DraftLink, type SwapConfig } from "./taproomConsumption";
import type { PhysicalCount } from "./inventory";

function count(id: string, quantity: number, occurredAt: string): PhysicalCount {
  return {
    id,
    catalog_object_id: "draft-sqvar",
    catalog_object_type: "ITEM_VARIATION",
    state: "IN_STOCK",
    location_id: "LZ8TH4A632YW0",
    quantity: String(quantity),
    occurred_at: occurredAt,
    created_at: occurredAt,
  };
}

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
    physicalCountsByVar: new Map<string, PhysicalCount[]>(),
    swapByRecipe: new Map<string, SwapConfig>(),
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

describe("assembleConsumption — draft swaps", () => {
  // A low→high crossing over the 580/660 threshold = one detected swap.
  const swapCounts: PhysicalCount[] = [
    count("pc-1", 600, "2026-07-01T12:00:00Z"), // full
    count("pc-2", 120, "2026-07-02T12:00:00Z"), // poured down (< 580)
    count("pc-3", 640, "2026-07-03T12:00:00Z"), // fresh keg tapped (>= 580) → swap
  ];

  const draftLink: DraftLink = {
    squareVariationId: "draft-sqvar",
    recipeId: "recipe-draft",
    beerName: "Pilsner",
  };

  it("emits one draft_swap unit per swap when config is complete", () => {
    const { units, discrepancies } = assembleConsumption({
      ...empty(),
      draftLinks: [draftLink],
      physicalCountsByVar: new Map([["draft-sqvar", swapCounts]]),
      swapByRecipe: new Map([["recipe-draft", { swapVariationId: "pv-swap", swapVolumeFlOz: 660 }]]),
    });

    expect(discrepancies).toEqual([]);
    expect(units).toHaveLength(1);
    expect(units[0]).toEqual({
      recipeId: "recipe-draft",
      variationId: "pv-swap",
      quantity: 1,
      sourceRef: "sqkegswap:pc-3",
      kind: "draft_swap",
      label: "Pilsner · keg swap · 2026-07-03",
    });
  });

  it("reports an unconfigured_draft_swap discrepancy when swaps exist but config is incomplete", () => {
    const { units, discrepancies } = assembleConsumption({
      ...empty(),
      draftLinks: [draftLink],
      physicalCountsByVar: new Map([["draft-sqvar", swapCounts]]),
      // swapVariationId present but volume missing → incomplete
      swapByRecipe: new Map([["recipe-draft", { swapVariationId: "pv-swap", swapVolumeFlOz: null }]]),
    });

    expect(units).toEqual([]);
    expect(discrepancies).toEqual([
      { kind: "unconfigured_draft_swap", recipeId: "recipe-draft", beerName: "Pilsner", swapCount: 1 },
    ]);
  });

  it("emits nothing when config is complete but no swaps are detected", () => {
    const noSwapCounts: PhysicalCount[] = [
      count("pc-1", 400, "2026-07-01T12:00:00Z"),
      count("pc-2", 200, "2026-07-02T12:00:00Z"),
      count("pc-3", 60, "2026-07-03T12:00:00Z"), // monotonic drain, never crosses up
    ];

    const { units, discrepancies } = assembleConsumption({
      ...empty(),
      draftLinks: [draftLink],
      physicalCountsByVar: new Map([["draft-sqvar", noSwapCounts]]),
      swapByRecipe: new Map([["recipe-draft", { swapVariationId: "pv-swap", swapVolumeFlOz: 660 }]]),
    });

    expect(units).toEqual([]);
    expect(discrepancies).toEqual([]);
  });
});

// lib/production/recordTaproomConsumption.test.ts
//
// Unit tests for recordTaproomConsumption's "record available, phantom the
// rest" policy. It reads the current cold-storage availability, records
// min(quantity, available) via writeColdStorageShipment on the taproom
// channel, and books any remaining shortfall as a batch-less phantom export
// (writePhantomExport) so barrel excise is never dropped — never depleting
// cold storage below zero. We mock all three leaf helpers and assert the
// orchestration.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("./shipmentWriter", () => ({
  writeColdStorageShipment: vi.fn(),
}));
vi.mock("./writePhantomExport", () => ({
  writePhantomExport: vi.fn(),
}));
vi.mock("./coldStorageDepletion", () => ({
  getAvailableColdStorageQuantity: vi.fn(),
}));
vi.mock("./applyBreakDown", () => ({ applyBreakDown: vi.fn() }));
vi.mock("./coldStorageGroupDraw", () => ({
  fetchGroupDraw: vi.fn(),
  fetchGroupLots: vi.fn(),
  orderGroupByAge: vi.fn(),
}));

import { recordTaproomConsumption } from "./recordTaproomConsumption";
import { writeColdStorageShipment } from "./shipmentWriter";
import { writePhantomExport } from "./writePhantomExport";
import { getAvailableColdStorageQuantity } from "./coldStorageDepletion";
import { applyBreakDown } from "./applyBreakDown";
import { fetchGroupDraw, fetchGroupLots, orderGroupByAge } from "./coldStorageGroupDraw";

const writeMock = vi.mocked(writeColdStorageShipment);
const phantomMock = vi.mocked(writePhantomExport);
const availableMock = vi.mocked(getAvailableColdStorageQuantity);
const applyBreakDownMock = vi.mocked(applyBreakDown);
const groupDrawMock = vi.mocked(fetchGroupDraw);
const groupLotsMock = vi.mocked(fetchGroupLots);
const orderGroupMock = vi.mocked(orderGroupByAge);

const supabase = {} as unknown as SupabaseClient;

const baseParams = {
  shipmentId: "ship-1",
  recipeId: "recipe-1",
  variationId: "variation-1",
  sourceRef: "square-order-42",
  notes: "auto sync",
  kind: "draft_swap" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no break-down found/needed (the original, non-shortage-side tests
  // aren't exercising the break-down branch — individual tests override this
  // when they specifically want to assert a break happening).
  applyBreakDownMock.mockResolvedValue({ applied: [], shortfall: 0, warnings: [] });
  writeMock.mockResolvedValue({
    shipmentId: "ship-1",
    exportTransactionIds: ["tx-1", "tx-2"],
    depleted: [],
    created: [],
    warnings: [],
  });
  phantomMock.mockResolvedValue({
    shipmentId: "ship-1",
    exportTransactionId: "tx-phantom",
  });
  groupLotsMock.mockResolvedValue([]);
  orderGroupMock.mockImplementation((_lots, ids) => [...ids]);
});

describe("recordTaproomConsumption", () => {
  it("records the full quantity when availability meets or exceeds it", async () => {
    availableMock.mockResolvedValue(10);

    const result = await recordTaproomConsumption(supabase, { ...baseParams, quantity: 6 });

    expect(writeMock).toHaveBeenCalledTimes(1);
    const call = writeMock.mock.calls[0][1];
    expect(call.quantity).toBe(6);
    expect(call.channel).toBe("taproom");
    expect(call.sourceRef).toBe("square-order-42");
    expect(call.shipmentId).toBe("ship-1");

    expect(result.recordedQty).toBe(6);
    expect(result.shortfallQty).toBe(0);
    expect(result.exportTransactionIds).toEqual(["tx-1", "tx-2"]);
    expect(result.breaks).toEqual([]);
    expect(result.warnings).toEqual([]);
    // Full stock: no phantom export written at all.
    expect(phantomMock).not.toHaveBeenCalled();
  });

  it("records the covered portion physically and books the remainder as a phantom export (fractional)", async () => {
    availableMock.mockResolvedValue(2.5);
    writeMock.mockResolvedValue({
      shipmentId: "ship-1",
      exportTransactionIds: ["tx-physical"],
      depleted: [{ batchId: "B-1", depletedQty: 2.5 }],
      created: [],
      warnings: [],
    });
    phantomMock.mockResolvedValue({ shipmentId: "ship-1", exportTransactionId: "tx-phantom" });

    const result = await recordTaproomConsumption(supabase, { ...baseParams, quantity: 6 });

    // Physical write covers only what's available.
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock.mock.calls[0][1].quantity).toBe(2.5);
    expect(writeMock.mock.calls[0][1].shipmentId).toBe("ship-1");

    // Phantom write covers the true remainder, sharing the physical shipment id.
    expect(phantomMock).toHaveBeenCalledTimes(1);
    expect(phantomMock.mock.calls[0][1]).toMatchObject({
      shipmentId: "ship-1",
      recipeId: "recipe-1",
      variationId: "variation-1",
      quantityKegs: 3.5,
      sourceRef: "square-order-42",
    });

    expect(result.recordedQty).toBe(2.5);
    expect(result.shortfallQty).toBe(3.5);
    expect(result.exportTransactionIds).toEqual(["tx-physical", "tx-phantom"]);
    expect(result.breaks).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("writes only a phantom export (no physical shipment, no depletion) when no stock is available", async () => {
    availableMock.mockResolvedValue(0);

    const result = await recordTaproomConsumption(supabase, { ...baseParams, quantity: 6 });

    expect(writeMock).not.toHaveBeenCalled();
    expect(phantomMock).toHaveBeenCalledTimes(1);
    expect(phantomMock.mock.calls[0][1]).toMatchObject({
      shipmentId: "ship-1",
      recipeId: "recipe-1",
      variationId: "variation-1",
      quantityKegs: 6,
      sourceRef: "square-order-42",
    });

    expect(result.recordedQty).toBe(0);
    expect(result.shortfallQty).toBe(6);
    expect(result.exportTransactionIds).toEqual(["tx-phantom"]);
    expect(result.breaks).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe("recordTaproomConsumption break-down integration", () => {
  it("breaks a higher tier when short, then records against the topped-up single stock", async () => {
    availableMock
      .mockResolvedValueOnce(0) // initial: no loose singles
      .mockResolvedValueOnce(4); // after break: 4 singles
    applyBreakDownMock.mockResolvedValue({
      applied: [{ batchId: "B-040", fromVariationId: "pack", toVariationId: "single", toUnits: 4 }],
      shortfall: 0,
      warnings: [],
    });

    const result = await recordTaproomConsumption(supabase, {
      ...baseParams,
      variationId: "single",
      quantity: 3,
      sourceRef: "sqsale:x:2026-07-07",
    });

    expect(applyBreakDownMock).toHaveBeenCalledWith(supabase, {
      recipeId: baseParams.recipeId,
      variationId: "single",
      needed: 3,
      sourceRef: "sqsale:x:2026-07-07",
    });
    expect(result.recordedQty).toBe(3);
    expect(result.shortfallQty).toBe(0);
    expect(result.breaks).toEqual([{ batchId: "B-040", fromVariationId: "pack", toVariationId: "single", toUnits: 4 }]);
    expect(phantomMock).not.toHaveBeenCalled();
  });

  it("records the break-down top-up physically and phantoms only the true remainder", async () => {
    availableMock
      .mockResolvedValueOnce(0) // initial: no loose singles
      .mockResolvedValueOnce(4); // after break: only 4 singles topped up (need 7)
    applyBreakDownMock.mockResolvedValue({
      applied: [{ batchId: "B-040", fromVariationId: "pack", toVariationId: "single", toUnits: 4 }],
      shortfall: 3,
      warnings: [],
    });
    writeMock.mockResolvedValue({
      shipmentId: "ship-1",
      exportTransactionIds: ["tx-physical"],
      depleted: [{ batchId: "B-040", depletedQty: 4 }],
      created: [],
      warnings: [],
    });

    const result = await recordTaproomConsumption(supabase, {
      ...baseParams,
      variationId: "single",
      quantity: 7,
      sourceRef: "sqsale:x:2026-07-07",
    });

    // The topped-up 4 units are recorded physically...
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock.mock.calls[0][1].quantity).toBe(4);

    // ...and only the true remainder (7 - 4 = 3) becomes a phantom export.
    expect(phantomMock).toHaveBeenCalledTimes(1);
    expect(phantomMock.mock.calls[0][1]).toMatchObject({
      shipmentId: "ship-1",
      quantityKegs: 3,
      sourceRef: "sqsale:x:2026-07-07",
    });

    expect(result.recordedQty).toBe(4);
    expect(result.shortfallQty).toBe(3);
    expect(result.exportTransactionIds).toEqual(["tx-physical", "tx-phantom"]);
    expect(result.breaks).toEqual([{ batchId: "B-040", fromVariationId: "pack", toVariationId: "single", toUnits: 4 }]);
  });

  // Every consumption kind books its shortfall through this one function, so
  // the phantom row is the only place the kind can still be recovered later.
  // Without it Export Bay listed can sales as draft swaps.
  it.each([
    ["draft_swap" as const],
    ["keg_sale" as const],
    ["can_sale" as const],
  ])("stamps origin %s onto the phantom row it books", async (kind) => {
    availableMock.mockResolvedValue(0);

    await recordTaproomConsumption(supabase, {
      ...baseParams,
      kind,
      quantity: 2,
      sourceRef: "sqsale:x:2026-08-06",
    });

    expect(phantomMock).toHaveBeenCalledTimes(1);
    expect(phantomMock.mock.calls[0][1]).toMatchObject({ origin: kind });
  });

  it("does not attempt a break when the target tier already has enough", async () => {
    availableMock.mockResolvedValueOnce(10);

    const result = await recordTaproomConsumption(supabase, {
      ...baseParams,
      variationId: "single",
      quantity: 3,
      sourceRef: "x",
    });

    expect(applyBreakDownMock).not.toHaveBeenCalled();
    expect(result.recordedQty).toBe(3);
    expect(result.breaks).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("surfaces deriveCansEach warnings from applyBreakDown instead of discarding them", async () => {
    availableMock
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(4);
    applyBreakDownMock.mockResolvedValue({
      applied: [{ batchId: "B-040", fromVariationId: "pack", toVariationId: "single", toUnits: 4 }],
      shortfall: 0,
      warnings: ["6-pack variation v-pack: volume implies 4 cans, expected 6 for format '6-pack'"],
    });

    const result = await recordTaproomConsumption(supabase, {
      ...baseParams,
      variationId: "single",
      quantity: 3,
      sourceRef: "sqsale:x:2026-07-07",
    });

    expect(result.warnings).toEqual(["6-pack variation v-pack: volume implies 4 cans, expected 6 for format '6-pack'"]);
  });
});

// A Square button declared fungible (square_fungible_skus) sells one product
// backed by several packagings. The sale is filled across them oldest-lot-first,
// and each packaging still gets its OWN export row — collapsing them would put
// one can's volume and packaging-loss on beer that came out of another.
describe("recordTaproomConsumption across a fungible group", () => {
  const groupParams = {
    ...baseParams,
    kind: "can_sale" as const,
    variationIds: ["variation-printed", "variation-labeled"],
  };

  it("writes one shipment per packaging the draw touched, sharing a shipment id", async () => {
    groupDrawMock.mockResolvedValue({
      slices: [
        { variationId: "variation-printed", quantity: 10 },
        { variationId: "variation-labeled", quantity: 4 },
      ],
      shortfall: 0,
    });

    const res = await recordTaproomConsumption(supabase, { ...groupParams, quantity: 14 });

    expect(writeMock).toHaveBeenCalledTimes(2);
    expect(writeMock.mock.calls[0][1]).toMatchObject({ variationId: "variation-printed", quantity: 10, shipmentId: "ship-1" });
    expect(writeMock.mock.calls[1][1]).toMatchObject({ variationId: "variation-labeled", quantity: 4, shipmentId: "ship-1" });
    expect(phantomMock).not.toHaveBeenCalled();
    expect(res).toMatchObject({ recordedQty: 14, shortfallQty: 0 });
  });

  it("does not break anything open while the group still has stock on hand", async () => {
    groupDrawMock.mockResolvedValue({
      slices: [{ variationId: "variation-printed", quantity: 3 }],
      shortfall: 0,
    });

    await recordTaproomConsumption(supabase, { ...groupParams, quantity: 3 });

    expect(applyBreakDownMock).not.toHaveBeenCalled();
  });

  it("cracks a higher tier only after the whole group's on-hand is gone", async () => {
    groupDrawMock.mockResolvedValue({
      slices: [{ variationId: "variation-printed", quantity: 2 }],
      shortfall: 3,
    });
    applyBreakDownMock.mockResolvedValue({
      applied: [{ batchId: "b1", fromVariationId: "v-case", toVariationId: "variation-printed", toUnits: 6 }],
      shortfall: 0,
      warnings: [],
    });
    availableMock.mockResolvedValue(6);

    const res = await recordTaproomConsumption(supabase, { ...groupParams, quantity: 5 });

    expect(applyBreakDownMock).toHaveBeenCalledWith(supabase, expect.objectContaining({ variationId: "variation-printed", needed: 3 }));
    expect(writeMock).toHaveBeenLastCalledWith(supabase, expect.objectContaining({ variationId: "variation-printed", quantity: 3 }));
    expect(res).toMatchObject({ recordedQty: 5, shortfallQty: 0 });
    expect(res.breaks).toHaveLength(1);
  });

  // The oldest CASES go first for the same reason the oldest singles do.
  it("tries the packaging with the oldest stock first when cracking", async () => {
    groupDrawMock.mockResolvedValue({ slices: [], shortfall: 4 });
    orderGroupMock.mockReturnValue(["variation-labeled", "variation-printed"]);
    applyBreakDownMock.mockResolvedValue({ applied: [], shortfall: 0, warnings: [] });

    await recordTaproomConsumption(supabase, { ...groupParams, quantity: 4 });

    expect(applyBreakDownMock.mock.calls.map((c) => c[1].variationId)).toEqual([
      "variation-labeled",
      "variation-printed",
    ]);
  });

  it("phantoms only what the whole group could not cover, against the packaging that ran out", async () => {
    groupDrawMock.mockResolvedValue({
      slices: [
        { variationId: "variation-printed", quantity: 2 },
        { variationId: "variation-labeled", quantity: 1 },
      ],
      shortfall: 2,
    });

    const res = await recordTaproomConsumption(supabase, { ...groupParams, quantity: 5 });

    expect(phantomMock).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ variationId: "variation-labeled", quantityKegs: 2 }),
    );
    expect(res).toMatchObject({ recordedQty: 3, shortfallQty: 2 });
  });

  it("charges the shortfall to the link's own packaging when the group was already empty", async () => {
    groupDrawMock.mockResolvedValue({ slices: [], shortfall: 5 });

    await recordTaproomConsumption(supabase, { ...groupParams, quantity: 5 });

    expect(writeMock).not.toHaveBeenCalled();
    expect(phantomMock).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ variationId: "variation-1", quantityKegs: 5 }),
    );
  });

  // Everything that is not a declared group must keep the path it has always
  // taken, untouched.
  it("leaves a one-member group on the single-variation path", async () => {
    availableMock.mockResolvedValue(5);

    await recordTaproomConsumption(supabase, { ...baseParams, variationIds: ["variation-1"], quantity: 5 });

    expect(groupDrawMock).not.toHaveBeenCalled();
    expect(availableMock).toHaveBeenCalled();
  });
});

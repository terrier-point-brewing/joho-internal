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

import { recordTaproomConsumption } from "./recordTaproomConsumption";
import { writeColdStorageShipment } from "./shipmentWriter";
import { writePhantomExport } from "./writePhantomExport";
import { getAvailableColdStorageQuantity } from "./coldStorageDepletion";
import { applyBreakDown } from "./applyBreakDown";

const writeMock = vi.mocked(writeColdStorageShipment);
const phantomMock = vi.mocked(writePhantomExport);
const availableMock = vi.mocked(getAvailableColdStorageQuantity);
const applyBreakDownMock = vi.mocked(applyBreakDown);

const supabase = {} as unknown as SupabaseClient;

const baseParams = {
  shipmentId: "ship-1",
  recipeId: "recipe-1",
  variationId: "variation-1",
  sourceRef: "square-order-42",
  notes: "auto sync",
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

// lib/production/recordTaproomConsumption.test.ts
//
// Unit tests for recordTaproomConsumption's "record available, flag the rest"
// policy. It reads the current cold-storage availability, records min(quantity,
// available) via writeColdStorageShipment on the taproom channel, and reports
// the remainder as a shortfall — never depleting below zero, never writing when
// nothing is available. We mock both leaf helpers and assert the orchestration.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("./shipmentWriter", () => ({
  writeColdStorageShipment: vi.fn(),
}));
vi.mock("./coldStorageDepletion", () => ({
  getAvailableColdStorageQuantity: vi.fn(),
}));
vi.mock("./applyBreakDown", () => ({ applyBreakDown: vi.fn() }));

import { recordTaproomConsumption } from "./recordTaproomConsumption";
import { writeColdStorageShipment } from "./shipmentWriter";
import { getAvailableColdStorageQuantity } from "./coldStorageDepletion";
import { applyBreakDown } from "./applyBreakDown";

const writeMock = vi.mocked(writeColdStorageShipment);
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
  });

  it("records only what is available and flags the shortfall (fractional)", async () => {
    availableMock.mockResolvedValue(2.5);

    const result = await recordTaproomConsumption(supabase, { ...baseParams, quantity: 6 });

    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock.mock.calls[0][1].quantity).toBe(2.5);

    expect(result.recordedQty).toBe(2.5);
    expect(result.shortfallQty).toBe(3.5);
    expect(result.exportTransactionIds).toEqual(["tx-1", "tx-2"]);
    expect(result.breaks).toEqual([]);
  });

  it("records nothing when no stock is available", async () => {
    availableMock.mockResolvedValue(0);

    const result = await recordTaproomConsumption(supabase, { ...baseParams, quantity: 6 });

    expect(writeMock).not.toHaveBeenCalled();
    expect(result.recordedQty).toBe(0);
    expect(result.shortfallQty).toBe(6);
    expect(result.exportTransactionIds).toEqual([]);
    expect(result.breaks).toEqual([]);
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
  });
});

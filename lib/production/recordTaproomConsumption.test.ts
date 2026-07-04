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

import { recordTaproomConsumption } from "./recordTaproomConsumption";
import { writeColdStorageShipment } from "./shipmentWriter";
import { getAvailableColdStorageQuantity } from "./coldStorageDepletion";

const writeMock = vi.mocked(writeColdStorageShipment);
const availableMock = vi.mocked(getAvailableColdStorageQuantity);

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
  });

  it("records only what is available and flags the shortfall (fractional)", async () => {
    availableMock.mockResolvedValue(2.5);

    const result = await recordTaproomConsumption(supabase, { ...baseParams, quantity: 6 });

    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock.mock.calls[0][1].quantity).toBe(2.5);

    expect(result.recordedQty).toBe(2.5);
    expect(result.shortfallQty).toBe(3.5);
    expect(result.exportTransactionIds).toEqual(["tx-1", "tx-2"]);
  });

  it("records nothing when no stock is available", async () => {
    availableMock.mockResolvedValue(0);

    const result = await recordTaproomConsumption(supabase, { ...baseParams, quantity: 6 });

    expect(writeMock).not.toHaveBeenCalled();
    expect(result.recordedQty).toBe(0);
    expect(result.shortfallQty).toBe(6);
    expect(result.exportTransactionIds).toEqual([]);
  });
});

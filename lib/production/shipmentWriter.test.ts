// lib/production/shipmentWriter.test.ts
//
// Unit tests for writeColdStorageShipment's orchestration. The load-bearing
// behavior is the deplete→write loop: it resolves the variation once, depletes
// cold storage, then emits exactly one export_transaction per depleted row with
// per-row quantity + volumeBbl (depletedQty * total_volume_fl_oz / BBL_TO_FL_OZ),
// stamps sourceRef, reuses one shipmentId across rows, completes each batch, and
// returns exportTransactionIds index-aligned with the depleted rows. We mock the
// leaf helpers (deplete/units/writer/batchCompletion) and inject a fake supabase
// that returns a fixed variation row, then assert the REAL orchestration outputs.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("./coldStorageDepletion", () => ({
  depleteColdStorageInventory: vi.fn(),
}));
vi.mock("./exportTransactionWriter", () => ({
  writeExportTransaction: vi.fn(),
}));
vi.mock("./packagingVariations", () => ({
  getUnitsPerPackage: vi.fn(),
}));
vi.mock("./batchCompletion", () => ({
  checkAndCompleteBatch: vi.fn(),
}));

import { writeColdStorageShipment } from "./shipmentWriter";
import { depleteColdStorageInventory } from "./coldStorageDepletion";
import { writeExportTransaction } from "./exportTransactionWriter";
import { getUnitsPerPackage } from "./packagingVariations";
import { checkAndCompleteBatch } from "./batchCompletion";
import { BBL_TO_FL_OZ } from "@/lib/constants/production";

const depleteMock = vi.mocked(depleteColdStorageInventory);
const writeTxMock = vi.mocked(writeExportTransaction);
const unitsMock = vi.mocked(getUnitsPerPackage);
const completeMock = vi.mocked(checkAndCompleteBatch);

const VARIATION = {
  total_volume_fl_oz: 992, // 992 / 3968 = 0.25 bbl per unit
  container_id: "container-1",
  name: "16oz Can 6-pack",
  format: "6-pack",
  tray_id: null,
  paktech_id: "paktech-1",
};

/** Fake supabase whose packaging_variations select().eq().single() returns VARIATION. */
function fakeSupabase(variation: unknown = VARIATION, varErr: string | null = null): SupabaseClient {
  const from = () => {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.single = () => Promise.resolve({ data: variation, error: varErr ? { message: varErr } : null });
    return b;
  };
  return { from } as unknown as SupabaseClient;
}

const baseParams = {
  channel: "distribution",
  recipeId: "recipe-1",
  variationId: "variation-1",
  quantity: 10,
};

beforeEach(() => {
  vi.clearAllMocks();
  unitsMock.mockResolvedValue(6);
  completeMock.mockResolvedValue(undefined);
});

describe("writeColdStorageShipment", () => {
  it("writes one export_transaction with the right volumeBbl and stamped sourceRef (single lot)", async () => {
    depleteMock.mockResolvedValue([{ batchId: "b1", depletedQty: 10 }]);
    writeTxMock.mockResolvedValue("tx-1");

    const result = await writeColdStorageShipment(fakeSupabase(), {
      ...baseParams,
      shipmentId: "ship-1",
      recipientId: "partner-1",
      recipientName: "Acme Distributing",
      sourceRef: "allocation:abc",
      notes: "handle with care",
    });

    expect(writeTxMock).toHaveBeenCalledTimes(1);
    const arg = writeTxMock.mock.calls[0][1];
    expect(arg).toMatchObject({
      shipmentId: "ship-1",
      batchId: "b1",
      recipeId: "recipe-1",
      packagingItemId: "container-1",
      variantLabel: "16oz Can 6-pack",
      quantity: 10,
      volumeBbl: (10 * VARIATION.total_volume_fl_oz) / BBL_TO_FL_OZ,
      channel: "distribution",
      recipientId: "partner-1",
      recipientName: "Acme Distributing",
      allocationId: null,
      notes: "handle with care",
      packagingFormat: "6-pack",
      unitsPerPackage: 6,
      sourceRef: "allocation:abc",
    });

    expect(completeMock).toHaveBeenCalledTimes(1);
    expect(completeMock).toHaveBeenCalledWith(expect.anything(), "b1");
    expect(result).toEqual({
      shipmentId: "ship-1",
      exportTransactionIds: ["tx-1"],
      depleted: [{ batchId: "b1", depletedQty: 10 }],
      created: [{ batch_id: "b1", export_transaction_id: "tx-1" }],
      warnings: [],
    });
  });

  it("writes one tx per lot with per-row quantities and completes each batch (multi-lot)", async () => {
    depleteMock.mockResolvedValue([
      { batchId: "b1", depletedQty: 4 },
      { batchId: "b2", depletedQty: 6 },
    ]);
    writeTxMock.mockResolvedValueOnce("tx-a").mockResolvedValueOnce("tx-b");

    const result = await writeColdStorageShipment(fakeSupabase(), { ...baseParams, shipmentId: "ship-9" });

    expect(writeTxMock).toHaveBeenCalledTimes(2);
    expect(writeTxMock.mock.calls[0][1]).toMatchObject({
      batchId: "b1",
      quantity: 4,
      volumeBbl: (4 * VARIATION.total_volume_fl_oz) / BBL_TO_FL_OZ,
    });
    expect(writeTxMock.mock.calls[1][1]).toMatchObject({
      batchId: "b2",
      quantity: 6,
      volumeBbl: (6 * VARIATION.total_volume_fl_oz) / BBL_TO_FL_OZ,
    });

    expect(completeMock).toHaveBeenCalledTimes(2);
    expect(completeMock).toHaveBeenNthCalledWith(1, expect.anything(), "b1");
    expect(completeMock).toHaveBeenNthCalledWith(2, expect.anything(), "b2");

    // index-aligned with depleted rows
    expect(result.exportTransactionIds).toEqual(["tx-a", "tx-b"]);
    expect(result.depleted).toEqual([
      { batchId: "b1", depletedQty: 4 },
      { batchId: "b2", depletedQty: 6 },
    ]);
  });

  it("defaults shipmentId when omitted and reuses it across every row", async () => {
    depleteMock.mockResolvedValue([
      { batchId: "b1", depletedQty: 2 },
      { batchId: "b2", depletedQty: 3 },
    ]);
    writeTxMock.mockResolvedValueOnce("tx-a").mockResolvedValueOnce("tx-b");

    const result = await writeColdStorageShipment(fakeSupabase(), baseParams);

    expect(result.shipmentId).toBeTruthy();
    const usedShipmentIds = writeTxMock.mock.calls.map((c) => c[1].shipmentId);
    expect(usedShipmentIds).toEqual([result.shipmentId, result.shipmentId]);
  });

  it("defaults optional recipient/allocation/source/notes to null", async () => {
    depleteMock.mockResolvedValue([{ batchId: "b1", depletedQty: 1 }]);
    writeTxMock.mockResolvedValue("tx-1");

    await writeColdStorageShipment(fakeSupabase(), baseParams);

    expect(writeTxMock.mock.calls[0][1]).toMatchObject({
      recipientId: null,
      recipientName: null,
      allocationId: null,
      notes: null,
      sourceRef: null,
    });
  });

  it("returns empty arrays when nothing was depleted", async () => {
    depleteMock.mockResolvedValue([]);

    const result = await writeColdStorageShipment(fakeSupabase(), baseParams);

    expect(writeTxMock).not.toHaveBeenCalled();
    expect(completeMock).not.toHaveBeenCalled();
    expect(result.exportTransactionIds).toEqual([]);
    expect(result.depleted).toEqual([]);
  });

  it("throws when the variation cannot be found", async () => {
    await expect(
      writeColdStorageShipment(fakeSupabase(null), baseParams)
    ).rejects.toThrow("Variation not found.");
    expect(depleteMock).not.toHaveBeenCalled();
  });

  it("throws when the variation query errors", async () => {
    await expect(
      writeColdStorageShipment(fakeSupabase(null, "db down"), baseParams)
    ).rejects.toThrow("db down");
  });
});

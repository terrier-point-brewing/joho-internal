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

import { writeColdStorageShipment, resolvePackagingLossByBatch } from "./shipmentWriter";
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

/** A canning run row as resolvePackagingLossByBatch reads it. */
type CanningRun = { batch_id: string; quantity: number; packaging_loss_pct: number };

/**
 * Fake supabase serving two reads:
 *   • packaging_variations … .single()  → VARIATION
 *   • batch_transfers      … .in()      → the canning runs behind the loss lookup
 */
function fakeSupabase(
  variation: unknown = VARIATION,
  varErr: string | null = null,
  cannedRuns: CanningRun[] = [],
): SupabaseClient {
  const from = () => {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.in = () => Promise.resolve({ data: cannedRuns, error: null });
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

  it("leaves is_ad_hoc off by default — a missing allocation is not the same claim", async () => {
    // Taproom consumption, over-deliveries and revision reversals all ship with
    // a null allocation. Only the ad-hoc route may set the tag.
    depleteMock.mockResolvedValue([{ batchId: "b1", depletedQty: 10 }]);
    writeTxMock.mockResolvedValue("tx-1");

    await writeColdStorageShipment(fakeSupabase(), baseParams);

    expect(writeTxMock.mock.calls[0][1]).toMatchObject({ allocationId: null, isAdHoc: false });
  });

  it("stamps every uncredited row of an ad-hoc shipment", async () => {
    depleteMock.mockResolvedValue([
      { batchId: "b1", depletedQty: 4 },
      { batchId: "b2", depletedQty: 6 },
    ]);
    writeTxMock.mockResolvedValueOnce("tx-a").mockResolvedValueOnce("tx-b");

    await writeColdStorageShipment(fakeSupabase(), { ...baseParams, adHoc: true });

    expect(writeTxMock.mock.calls[0][1]).toMatchObject({ isAdHoc: true });
    expect(writeTxMock.mock.calls[1][1]).toMatchObject({ isAdHoc: true });
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

describe("resolvePackagingLossByBatch", () => {
  it("returns an empty map when no batches are drawn (no query issued)", async () => {
    const map = await resolvePackagingLossByBatch(fakeSupabase(), { variationId: "v1", batchIds: [] });
    expect(map.size).toBe(0);
  });

  it("takes a single run's loss verbatim", async () => {
    const map = await resolvePackagingLossByBatch(
      fakeSupabase(VARIATION, null, [{ batch_id: "b1", quantity: 100, packaging_loss_pct: 5 }]),
      { variationId: "v1", batchIds: ["b1"] },
    );
    expect(map.get("b1")).toBe(5);
  });

  it("weights several runs of one batch by quantity", async () => {
    // (5×100 + 10×300) / 400 = 8.75
    const map = await resolvePackagingLossByBatch(
      fakeSupabase(VARIATION, null, [
        { batch_id: "b1", quantity: 100, packaging_loss_pct: 5 },
        { batch_id: "b1", quantity: 300, packaging_loss_pct: 10 },
      ]),
      { variationId: "v1", batchIds: ["b1"] },
    );
    expect(map.get("b1")).toBe(8.75);
  });

  it("lets a zero-loss run dilute the average rather than skipping it", async () => {
    // (10×100 + 0×100) / 200 = 5
    const map = await resolvePackagingLossByBatch(
      fakeSupabase(VARIATION, null, [
        { batch_id: "b1", quantity: 100, packaging_loss_pct: 10 },
        { batch_id: "b1", quantity: 100, packaging_loss_pct: 0 },
      ]),
      { variationId: "v1", batchIds: ["b1"] },
    );
    expect(map.get("b1")).toBe(5);
  });

  it("keeps batches separate and omits ones with no canning history", async () => {
    const map = await resolvePackagingLossByBatch(
      fakeSupabase(VARIATION, null, [
        { batch_id: "b1", quantity: 100, packaging_loss_pct: 5 },
        { batch_id: "b2", quantity: 100, packaging_loss_pct: 12 },
      ]),
      { variationId: "v1", batchIds: ["b1", "b2", "b3"] },
    );
    expect(map.get("b1")).toBe(5);
    expect(map.get("b2")).toBe(12);
    expect(map.has("b3")).toBe(false); // caller defaults it to 0
  });

  it("ignores rows with no quantity so they can't divide by zero", async () => {
    const map = await resolvePackagingLossByBatch(
      fakeSupabase(VARIATION, null, [{ batch_id: "b1", quantity: 0, packaging_loss_pct: 5 }]),
      { variationId: "v1", batchIds: ["b1"] },
    );
    expect(map.has("b1")).toBe(false);
  });
});

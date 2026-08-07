import { vi, describe, it, expect, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("./coldStorageDepletion", () => ({
  depleteColdStorageInventory: vi.fn().mockResolvedValue([]),
}));
vi.mock("./batchCompletion", () => ({
  checkAndCompleteBatch: vi.fn().mockResolvedValue(undefined),
}));

import { reconcilePhantomExport, dismissPhantomExport, PhantomReconcileError } from "./reconcilePhantom";
import { depleteColdStorageInventory } from "./coldStorageDepletion";
import { checkAndCompleteBatch } from "./batchCompletion";

type Call = { method: string; args: unknown[] };

function makeSupabase(tables: Record<string, { rows: unknown[] | null; error?: string | null }>) {
  const calls: Record<string, Call[]> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const from = (table: string): any => {
    const cfg = tables[table] ?? { rows: [] };
    calls[table] = calls[table] ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder: Record<string, any> = {};
    const chain = (method: string) => (...args: unknown[]) => { calls[table].push({ method, args }); return builder; };
    builder.select = chain("select");
    builder.eq = chain("eq");
    builder.is = chain("is");
    builder.in = chain("in");
    builder.order = chain("order");
    builder.update = chain("update");
    builder.then = (resolve: (v: { data: unknown; error: unknown }) => unknown) =>
      Promise.resolve({ data: cfg.rows, error: cfg.error ? { message: cfg.error } : null }).then(resolve);
    return builder;
  };
  return { client: { from } as unknown as SupabaseClient, calls };
}

const openPhantom = {
  id: "et-1",
  recipe_id: "r1",
  packaging_item_id: "c1",
  packaging_format: "loose",
  quantity: 1,
  volume_bbl: 0.1666, // 1/6 keg → perKeg ≈ 661 fl oz
  is_phantom: true,
  alert_acknowledged_at: null,
};
// Chosen variation whose container matches the booked one (no label correction).
const sameVariation = { id: "pv-1", name: "1/6 Keg", container_id: "c1", format: "loose", total_volume_fl_oz: 661, container: { type: "keg" } };
// Chosen variation on a DIFFERENT container, same size (label correction expected).
const otherVariation = { id: "pv-2", name: "1/6 Keg", container_id: "c2", format: "loose", total_volume_fl_oz: 661, container: { type: "keg" } };

function tables(overrides: Record<string, { rows: unknown[] | null; error?: string | null }> = {}) {
  return {
    export_transactions: { rows: [openPhantom] },
    packaging_variations: { rows: [sameVariation] },
    // Container type of the BOOKED row — the match is scoped to it.
    packaging_items: { rows: [{ type: "keg" }] },
    cold_storage_inventory: { rows: [{ quantity_on_hand: 2 }] },
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(depleteColdStorageInventory).mockClear();
  vi.mocked(checkAndCompleteBatch).mockClear();
});

describe("reconcilePhantomExport", () => {
  it("depletes the chosen lot, backfills batch_id, acknowledges, completes the batch (same variation)", async () => {
    const { client, calls } = makeSupabase(tables());
    await reconcilePhantomExport(client, { exportTransactionId: "et-1", variationId: "pv-1", batchId: "b1" });

    expect(depleteColdStorageInventory).toHaveBeenCalledWith(client, {
      recipeId: "r1",
      variationId: "pv-1",
      quantity: 1,
      batchId: "b1",
    });
    const update = calls.export_transactions.find((c) => c.method === "update");
    expect(update?.args[0]).toMatchObject({ batch_id: "b1", alert_acknowledged_at: expect.any(String) });
    // Same container as booked → no variation-label correction, is_phantom untouched.
    expect(update?.args[0]).not.toHaveProperty("variant_label");
    expect(update?.args[0]).not.toHaveProperty("is_phantom");
    expect(checkAndCompleteBatch).toHaveBeenCalledWith(client, "b1");
  });

  it("corrects the export record's variation when a different same-size keg is chosen", async () => {
    const { client, calls } = makeSupabase(tables({ packaging_variations: { rows: [otherVariation] } }));
    await reconcilePhantomExport(client, { exportTransactionId: "et-1", variationId: "pv-2", batchId: "b1" });
    const update = calls.export_transactions.find((c) => c.method === "update");
    expect(update?.args[0]).toMatchObject({
      batch_id: "b1",
      packaging_item_id: "c2",
      packaging_format: "loose",
      variant_label: "1/6 Keg",
    });
  });

  it("rejects a different-size keg and does not deplete", async () => {
    const bigKeg = { ...sameVariation, total_volume_fl_oz: 1984 };
    const { client } = makeSupabase(tables({ packaging_variations: { rows: [bigKeg] } }));
    await expect(reconcilePhantomExport(client, { exportTransactionId: "et-1", variationId: "pv-1", batchId: "b1" }))
      .rejects.toThrow(/different size/i);
    expect(depleteColdStorageInventory).not.toHaveBeenCalled();
  });

  it("rejects a variation whose container type differs from the booking", async () => {
    const canVar = { ...sameVariation, container: { type: "can" } };
    const { client } = makeSupabase(tables({ packaging_variations: { rows: [canVar] } }));
    await expect(reconcilePhantomExport(client, { exportTransactionId: "et-1", variationId: "pv-1", batchId: "b1" }))
      .rejects.toThrow(/but the booking was a keg/i);
  });

  // The rule was never "must be a keg" — it is "must be the same kind of thing
  // that was booked". A can booking resolves against matching can stock, which
  // the keg-only check made impossible.
  it("accepts a can variation when the booking itself was a can", async () => {
    const canVar = { ...sameVariation, name: "16oz Can 4-Pack", total_volume_fl_oz: 64, container: { type: "can" } };
    const { client } = makeSupabase(tables({
      export_transactions: { rows: [{ ...openPhantom, volume_bbl: 0.0161 }] }, // 64 fl oz
      packaging_variations: { rows: [canVar] },
      packaging_items: { rows: [{ type: "can" }] },
    }));
    await reconcilePhantomExport(client, { exportTransactionId: "et-1", variationId: "pv-1", batchId: "b1" });
    expect(depleteColdStorageInventory).toHaveBeenCalled();
  });

  it("rejects when the chosen variation is not found", async () => {
    const { client } = makeSupabase(tables({ packaging_variations: { rows: [] } }));
    await expect(reconcilePhantomExport(client, { exportTransactionId: "et-1", variationId: "pv-x", batchId: "b1" }))
      .rejects.toThrow(/not found/i);
  });

  it("rejects when the export is not found", async () => {
    const { client } = makeSupabase(tables({ export_transactions: { rows: [] } }));
    await expect(reconcilePhantomExport(client, { exportTransactionId: "x", variationId: "pv-1", batchId: "b1" }))
      .rejects.toBeInstanceOf(PhantomReconcileError);
    expect(depleteColdStorageInventory).not.toHaveBeenCalled();
  });

  it("rejects when the export is not a phantom", async () => {
    const { client } = makeSupabase(tables({ export_transactions: { rows: [{ ...openPhantom, is_phantom: false }] } }));
    await expect(reconcilePhantomExport(client, { exportTransactionId: "et-1", variationId: "pv-1", batchId: "b1" }))
      .rejects.toThrow(/not a phantom/i);
  });

  it("rejects when the alert is already resolved", async () => {
    const { client } = makeSupabase(
      tables({ export_transactions: { rows: [{ ...openPhantom, alert_acknowledged_at: "2026-07-18T00:00:00Z" }] } }),
    );
    await expect(reconcilePhantomExport(client, { exportTransactionId: "et-1", variationId: "pv-1", batchId: "b1" }))
      .rejects.toThrow(/already been resolved/i);
  });

  it("rejects and does not deplete when the lot lacks enough on hand", async () => {
    const { client } = makeSupabase(tables({ cold_storage_inventory: { rows: [{ quantity_on_hand: 0.5 }] } }));
    await expect(reconcilePhantomExport(client, { exportTransactionId: "et-1", variationId: "pv-1", batchId: "b1" }))
      .rejects.toThrow(/on hand/i);
    expect(depleteColdStorageInventory).not.toHaveBeenCalled();
  });
});

describe("dismissPhantomExport", () => {
  it("acknowledges without depleting", async () => {
    const { client, calls } = makeSupabase(tables());
    await dismissPhantomExport(client, { exportTransactionId: "et-1" });
    const update = calls.export_transactions.find((c) => c.method === "update");
    expect(update?.args[0]).toMatchObject({ alert_acknowledged_at: expect.any(String) });
    expect(update?.args[0]).not.toHaveProperty("batch_id");
    expect(depleteColdStorageInventory).not.toHaveBeenCalled();
  });

  it("rejects an already-resolved alert", async () => {
    const { client } = makeSupabase(
      tables({ export_transactions: { rows: [{ ...openPhantom, alert_acknowledged_at: "2026-07-18T00:00:00Z" }] } }),
    );
    await expect(dismissPhantomExport(client, { exportTransactionId: "et-1" })).rejects.toThrow(/already been resolved/i);
  });
});

// lib/production/coldStorageDepletion.test.ts
//
// Characterization tests for the cold-storage depletion math. Both functions are
// async DB orchestration, but the load-bearing logic is pure: getAvailable sums
// quantity_on_hand; deplete walks oldest-row-first taking Math.min(rowQty, left),
// deleting a row that hits ~0 and decrementing otherwise. We drive them with a
// stub that returns fixed inventory rows and records the delete/update effects,
// then assert the REAL returned depletion entries and per-row outcomes — not that
// a mock was called. Boundaries: empty inventory, exact-fit, partial last row,
// over-request (depletes all it finds), the 0.0001 delete threshold, zero qty.
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getAvailableColdStorageQuantity,
  depleteColdStorageInventory,
} from "./coldStorageDepletion";

interface Row { id: string; batch_id: string; quantity_on_hand: number; created_at: string }
interface Effect { op: "delete" | "update"; id: string; newQty?: number }

// ── getAvailableColdStorageQuantity ──────────────────────────────────────────
function availStub(rows: Array<{ quantity_on_hand: number }> | null, error: string | null = null): SupabaseClient {
  const b = {
    select: () => b,
    eq: () => b,
    // second .eq is awaited directly
    then: (res: (v: { data: unknown; error: unknown }) => unknown) =>
      Promise.resolve({ data: rows, error: error ? { message: error } : null }).then(res),
  };
  return { from: () => b } as unknown as SupabaseClient;
}

describe("getAvailableColdStorageQuantity", () => {
  const key = { recipeId: "r1", variationId: "v1" };

  it("sums quantity_on_hand across all matching rows", async () => {
    const qty = await getAvailableColdStorageQuantity(availStub([
      { quantity_on_hand: 10 }, { quantity_on_hand: 5.5 }, { quantity_on_hand: 0 },
    ]), key);
    expect(qty).toBe(15.5);
  });

  it("returns 0 for no matching rows", async () => {
    expect(await getAvailableColdStorageQuantity(availStub([]), key)).toBe(0);
  });

  it("treats null data as 0", async () => {
    expect(await getAvailableColdStorageQuantity(availStub(null), key)).toBe(0);
  });

  it("throws when the query errors", async () => {
    await expect(getAvailableColdStorageQuantity(availStub(null, "boom"), key)).rejects.toThrow("boom");
  });
});

// ── depleteColdStorageInventory ──────────────────────────────────────────────
/** Stub for deplete: .select().eq().eq().order() resolves to rows; delete/update recorded. */
function deplStub(rows: Row[], error: string | null = null): { client: SupabaseClient; effects: Effect[] } {
  const effects: Effect[] = [];
  const from = () => {
    let mode: "delete" | "update" | "read" = "read";
    let newQty: number | undefined;
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.delete = () => { mode = "delete"; return b; };
    b.update = (payload: { quantity_on_hand: number }) => { mode = "update"; newQty = payload.quantity_on_hand; return b; };
    b.eq = (col: string, val: unknown) => {
      if (mode === "delete") { effects.push({ op: "delete", id: String(val) }); return Promise.resolve({ error: null }); }
      if (mode === "update") { effects.push({ op: "update", id: String(val), newQty }); return Promise.resolve({ error: null }); }
      return b;
    };
    b.order = () => Promise.resolve({ data: rows, error: error ? { message: error } : null });
    return b;
  };
  return { client: { from } as unknown as SupabaseClient, effects };
}

const baseKey = { recipeId: "r1", variationId: "v1" };
const rowsFixture: Row[] = [
  { id: "row-old", batch_id: "b1", quantity_on_hand: 4, created_at: "2026-01-01" },
  { id: "row-mid", batch_id: "b2", quantity_on_hand: 6, created_at: "2026-02-01" },
  { id: "row-new", batch_id: "b3", quantity_on_hand: 5, created_at: "2026-03-01" },
];

describe("depleteColdStorageInventory", () => {
  it("depletes oldest-first and deletes a fully-consumed row", async () => {
    const { client, effects } = deplStub(rowsFixture);
    const result = await depleteColdStorageInventory(client, { ...baseKey, quantity: 4 });
    expect(result).toEqual([{ batchId: "b1", depletedQty: 4 }]);
    expect(effects).toEqual([{ op: "delete", id: "row-old" }]);
  });

  it("decrements (not deletes) a partially-consumed row", async () => {
    const { client, effects } = deplStub(rowsFixture);
    const result = await depleteColdStorageInventory(client, { ...baseKey, quantity: 2 });
    expect(result).toEqual([{ batchId: "b1", depletedQty: 2 }]);
    expect(effects).toEqual([{ op: "update", id: "row-old", newQty: 2 }]);
  });

  it("spans multiple rows oldest-first, deleting full ones and decrementing the last", async () => {
    const { client, effects } = deplStub(rowsFixture);
    // 4 (row-old, full) + 6 (row-mid, full) + 1 of row-new = 11
    const result = await depleteColdStorageInventory(client, { ...baseKey, quantity: 11 });
    expect(result).toEqual([
      { batchId: "b1", depletedQty: 4 },
      { batchId: "b2", depletedQty: 6 },
      { batchId: "b3", depletedQty: 1 },
    ]);
    expect(effects).toEqual([
      { op: "delete", id: "row-old" },
      { op: "delete", id: "row-mid" },
      { op: "update", id: "row-new", newQty: 4 },
    ]);
  });

  it("over-request depletes everything it finds (no re-check)", async () => {
    const { client, effects } = deplStub(rowsFixture);
    const result = await depleteColdStorageInventory(client, { ...baseKey, quantity: 1000 });
    expect(result.reduce((s, r) => s + r.depletedQty, 0)).toBe(15);
    expect(effects.every((e) => e.op === "delete")).toBe(true);
    expect(effects).toHaveLength(3);
  });

  it("returns empty and touches nothing for zero quantity", async () => {
    const { client, effects } = deplStub(rowsFixture);
    expect(await depleteColdStorageInventory(client, { ...baseKey, quantity: 0 })).toEqual([]);
    expect(effects).toEqual([]);
  });

  it("returns empty when there is no inventory", async () => {
    const { client, effects } = deplStub([]);
    expect(await depleteColdStorageInventory(client, { ...baseKey, quantity: 5 })).toEqual([]);
    expect(effects).toEqual([]);
  });

  it("deletes a row when the remainder falls within the 0.0001 dust threshold", async () => {
    const rows: Row[] = [{ id: "dust", batch_id: "b9", quantity_on_hand: 3, created_at: "2026-01-01" }];
    const { client, effects } = deplStub(rows);
    // take 2.99995 → newQty 0.00005 ≤ 0.0001 → delete
    await depleteColdStorageInventory(client, { ...baseKey, quantity: 2.99995 });
    expect(effects).toEqual([{ op: "delete", id: "dust" }]);
  });

  it("throws when the read query errors", async () => {
    const { client } = deplStub([], "read failed");
    await expect(depleteColdStorageInventory(client, { ...baseKey, quantity: 1 })).rejects.toThrow("read failed");
  });
});

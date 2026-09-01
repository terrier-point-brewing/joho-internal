import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { upsertColdStorageInventory } from "./coldStorageUpsert";

interface Captured {
  filters: [string, unknown][];
  updates: { id: string; patch: Record<string, unknown> }[];
  inserts: Record<string, unknown>[];
}

function fakeClient(opts: {
  existing?: { id: string; quantity_on_hand: number } | null;
  lookupError?: string;
  writeError?: string;
}) {
  const captured: Captured = { filters: [], updates: [], inserts: [] };

  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: (col: string, val: unknown) => { captured.filters.push([col, val]); return chain; },
    is: (col: string, val: unknown) => { captured.filters.push([col, val]); return chain; },
    maybeSingle: async () => ({
      data: opts.existing ?? null,
      error: opts.lookupError ? { message: opts.lookupError } : null,
    }),
    update: (patch: Record<string, unknown>) => ({
      eq: async (_c: string, id: string) => {
        captured.updates.push({ id, patch });
        return { error: opts.writeError ? { message: opts.writeError } : null };
      },
    }),
    insert: async (row: Record<string, unknown>) => {
      captured.inserts.push(row);
      return { error: opts.writeError ? { message: opts.writeError } : null };
    },
  };

  const client = { from: () => chain };
  return { client: client as unknown as SupabaseClient, captured };
}

const B057 = {
  batchId: "43c517a8",
  recipeId: "transfusion",
  variationId: "sixtel",
  quantityDelta: 3,
  sourceTransferId: "1f8d5e34",
};

describe("upsertColdStorageInventory", () => {
  it("keys the lot on batch AND variation AND recipe", async () => {
    const { client, captured } = fakeClient({ existing: null });
    await upsertColdStorageInventory(client, B057);
    expect(captured.filters).toEqual([
      ["batch_id", "43c517a8"],
      ["variation_id", "sixtel"],
      ["recipe_id", "transfusion"],
    ]);
  });

  it("matches a NULL recipe with `is`, not `eq`", async () => {
    const { client, captured } = fakeClient({ existing: null });
    await upsertColdStorageInventory(client, { ...B057, recipeId: null });
    expect(captured.filters[2]).toEqual(["recipe_id", null]);
  });

  it("creates the lot when the beer has not arrived in this container before", async () => {
    const { client, captured } = fakeClient({ existing: null });
    await upsertColdStorageInventory(client, B057);
    expect(captured.inserts).toEqual([{
      batch_id: "43c517a8",
      recipe_id: "transfusion",
      variation_id: "sixtel",
      quantity_on_hand: 3,
      source_transfer_id: "1f8d5e34",
    }]);
  });

  it("adds to an existing lot rather than replacing it", async () => {
    const { client, captured } = fakeClient({ existing: { id: "cs1", quantity_on_hand: 6 } });
    await upsertColdStorageInventory(client, B057);
    expect(captured.inserts).toEqual([]);
    expect(captured.updates).toEqual([
      { id: "cs1", patch: { quantity_on_hand: 9, source_transfer_id: "1f8d5e34" } },
    ]);
  });

  it("leaves provenance alone when the caller has none to stamp", async () => {
    // A refund restock joins the lot the packaging run created; it must not
    // claim to be the run that produced it.
    const { client, captured } = fakeClient({ existing: { id: "cs1", quantity_on_hand: 6 } });
    await upsertColdStorageInventory(client, { ...B057, sourceTransferId: undefined });
    expect(captured.updates[0].patch).toEqual({ quantity_on_hand: 9 });
  });

  // ── The 2026-08-31 B-057 failure: every one of these used to be swallowed ──

  it("throws when the lookup fails instead of writing a duplicate", async () => {
    // `.maybeSingle()` errors when more than one row matches — which means the
    // lot grain is broken. Reading that as "no existing row" would double-book.
    const { client, captured } = fakeClient({ lookupError: "multiple rows returned" });
    await expect(upsertColdStorageInventory(client, B057)).rejects.toThrow(/multiple rows returned/);
    expect(captured.inserts).toEqual([]);
    expect(captured.updates).toEqual([]);
  });

  it("throws when the insert is rejected", async () => {
    const { client } = fakeClient({
      existing: null,
      writeError: 'duplicate key value violates unique constraint "cold_storage_inventory_batch_variation_idx"',
    });
    await expect(upsertColdStorageInventory(client, B057)).rejects.toThrow(/unique constraint/);
  });

  it("throws when the update is rejected", async () => {
    const { client } = fakeClient({ existing: { id: "cs1", quantity_on_hand: 6 }, writeError: "permission denied" });
    await expect(upsertColdStorageInventory(client, B057)).rejects.toThrow(/permission denied/);
  });

  it("does nothing for a zero delta", async () => {
    const { client, captured } = fakeClient({ existing: null });
    await upsertColdStorageInventory(client, { ...B057, quantityDelta: 0 });
    expect(captured.filters).toEqual([]);
    expect(captured.inserts).toEqual([]);
  });
});

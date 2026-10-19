import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { receivePurchasedBeer, PURCHASED_BATCH_NOTE } from "./receivePurchasedBeer";

interface Captured {
  batchInserts: Record<string, unknown>[];
  coldStorageInserts: Record<string, unknown>[];
  coldStorageUpdates: { id: string; patch: Record<string, unknown> }[];
  receiptInserts: Record<string, unknown>[];
  order: string[];
}

/**
 * Covers the three tables the intake touches: brew_batches (find-or-create the
 * purchased placeholder), cold_storage_inventory (the upsert) and beer_receipts.
 * Records every write in order so the tests can assert cold storage lands
 * before the receipt.
 */
function fakeClient(opts: {
  existingBatchId?: string | null;
  existingLot?: { id: string; quantity_on_hand: number } | null;
  coldStorageError?: string;
  receiptError?: string;
}) {
  const captured: Captured = { batchInserts: [], coldStorageInserts: [], coldStorageUpdates: [], receiptInserts: [], order: [] };

  const from = (table: string) => {
    if (table === "brew_batches") {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.order = () => b;
      b.limit = () => b;
      b.maybeSingle = async () => ({ data: opts.existingBatchId ? { id: opts.existingBatchId } : null, error: null });
      b.insert = (row: Record<string, unknown>) => {
        captured.batchInserts.push(row);
        captured.order.push("brew_batches");
        return { select: () => ({ single: async () => ({ data: { id: "new-guest-batch" }, error: null }) }) };
      };
      return b;
    }
    if (table === "cold_storage_inventory") {
      const c: Record<string, unknown> = {};
      c.select = () => c;
      c.eq = () => c;
      c.is = () => c;
      c.maybeSingle = async () => ({ data: opts.existingLot ?? null, error: null });
      c.update = (patch: Record<string, unknown>) => ({
        eq: async (_col: string, id: string) => {
          captured.coldStorageUpdates.push({ id, patch });
          captured.order.push("cold_storage_inventory");
          return { error: opts.coldStorageError ? { message: opts.coldStorageError } : null };
        },
      });
      c.insert = async (row: Record<string, unknown>) => {
        captured.coldStorageInserts.push(row);
        captured.order.push("cold_storage_inventory");
        return { error: opts.coldStorageError ? { message: opts.coldStorageError } : null };
      };
      return c;
    }
    if (table === "beer_receipts") {
      return {
        insert: (row: Record<string, unknown>) => {
          captured.receiptInserts.push(row);
          captured.order.push("beer_receipts");
          return {
            select: () => ({
              single: async () =>
                opts.receiptError
                  ? { data: null, error: { message: opts.receiptError } }
                  : { data: { id: "receipt-1" }, error: null },
            }),
          };
        },
      };
    }
    throw new Error(`fakeClient: unexpected table ${table}`);
  };

  return { client: { from } as unknown as SupabaseClient, captured };
}

const DELIVERY = {
  recipeId: "oktoberfest",
  variationId: "case-16oz",
  quantity: 2,
  supplier: "Carolina Brewing Co",
  costCents: 9600,
  receivedOn: "2026-10-12",
  note: "two cases, picked up",
  userId: "user-1",
};

describe("receivePurchasedBeer", () => {
  it("creates the recipe's purchased placeholder with volume 0, no turns, complete", async () => {
    const { client, captured } = fakeClient({ existingBatchId: null });
    const result = await receivePurchasedBeer(client, DELIVERY);

    expect(result).toEqual({ batchId: "new-guest-batch", batchCreated: true, receiptId: "receipt-1" });
    expect(captured.batchInserts).toEqual([
      {
        recipe_id: "oktoberfest",
        source: "purchased",
        status: "complete",
        planned_brew_date: "2026-10-12",
        volume_bbl: 0,
        turns: 0,
        notes: PURCHASED_BATCH_NOTE,
      },
    ]);
  });

  it("reuses the existing placeholder instead of minting one per delivery", async () => {
    const { client, captured } = fakeClient({ existingBatchId: "guest-okt" });
    const result = await receivePurchasedBeer(client, DELIVERY);

    expect(result.batchId).toBe("guest-okt");
    expect(result.batchCreated).toBe(false);
    expect(captured.batchInserts).toHaveLength(0);
  });

  it("books cold storage on the purchased batch with no source transfer, then the receipt", async () => {
    const { client, captured } = fakeClient({ existingBatchId: "guest-okt" });
    await receivePurchasedBeer(client, DELIVERY);

    expect(captured.coldStorageInserts).toEqual([
      { batch_id: "guest-okt", recipe_id: "oktoberfest", variation_id: "case-16oz", quantity_on_hand: 2, source_transfer_id: null },
    ]);
    expect(captured.receiptInserts).toEqual([
      {
        batch_id: "guest-okt",
        recipe_id: "oktoberfest",
        variation_id: "case-16oz",
        quantity: 2,
        supplier: "Carolina Brewing Co",
        cost_cents: 9600,
        received_on: "2026-10-12",
        note: "two cases, picked up",
        created_by: "user-1",
      },
    ]);
    expect(captured.order).toEqual(["cold_storage_inventory", "beer_receipts"]);
  });

  it("adds to the lot the same beer already sits on", async () => {
    const { client, captured } = fakeClient({ existingBatchId: "guest-okt", existingLot: { id: "lot-1", quantity_on_hand: 1 } });
    await receivePurchasedBeer(client, DELIVERY);

    expect(captured.coldStorageInserts).toHaveLength(0);
    expect(captured.coldStorageUpdates).toEqual([{ id: "lot-1", patch: { quantity_on_hand: 3 } }]);
  });

  it("raises when cold storage cannot be written and records no receipt", async () => {
    const { client, captured } = fakeClient({ existingBatchId: "guest-okt", coldStorageError: "stale unique index" });
    await expect(receivePurchasedBeer(client, DELIVERY)).rejects.toThrow(/COLD STORAGE NOT BOOKED.*stale unique index/);
    expect(captured.receiptInserts).toHaveLength(0);
  });

  it("says the beer IS booked when only the receipt fails", async () => {
    const { client, captured } = fakeClient({ existingBatchId: "guest-okt", receiptError: "permission denied" });
    await expect(receivePurchasedBeer(client, DELIVERY)).rejects.toThrow(/IS in cold storage.*permission denied/);
    expect(captured.coldStorageInserts).toHaveLength(1);
  });

  it("refuses a non-positive quantity before touching anything", async () => {
    const { client, captured } = fakeClient({ existingBatchId: "guest-okt" });
    await expect(receivePurchasedBeer(client, { ...DELIVERY, quantity: 0 })).rejects.toThrow(/positive/);
    expect(captured.order).toEqual([]);
  });

  it("refuses a fractional or negative cost", async () => {
    const { client } = fakeClient({ existingBatchId: "guest-okt" });
    await expect(receivePurchasedBeer(client, { ...DELIVERY, costCents: 12.5 })).rejects.toThrow(/cents/);
    await expect(receivePurchasedBeer(client, { ...DELIVERY, costCents: -1 })).rejects.toThrow(/cents/);
  });
});

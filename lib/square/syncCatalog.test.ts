import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchItems = vi.fn();
const fetchCategories = vi.fn();
const fetchTaxes = vi.fn();

vi.mock("./catalog", () => ({
  fetchCatalogItems: (...a: unknown[]) => fetchItems(...a),
  fetchCatalogCategories: (...a: unknown[]) => fetchCategories(...a),
  fetchCatalogTaxes: (...a: unknown[]) => fetchTaxes(...a),
}));

import { syncSquareCatalog, markMissingAsDeleted } from "./syncCatalog";

interface UpdateCall { table: string; patch: Record<string, unknown>; lt?: [string, unknown]; eq?: [string, unknown] }

function fakeDb(opts: { rows?: Record<string, { id: string }[]> } = {}) {
  const upserts: { table: string; rows: Record<string, unknown>[] }[] = [];
  const updates: UpdateCall[] = [];
  const rpcs: string[] = [];

  const db = {
    from: (table: string) => ({
      upsert: (rows: Record<string, unknown>[]) => {
        upserts.push({ table, rows });
        return {
          select: () => ({
            data: rows.map((r, i) => ({
              id: `${table}-${i}`,
              square_item_id: r.square_item_id as string,
            })),
            error: null,
          }),
        };
      },
      update: (patch: Record<string, unknown>) => {
        const call: UpdateCall = { table, patch };
        updates.push(call);
        const chain = {
          lt: (c: string, v: unknown) => { call.lt = [c, v]; return chain; },
          eq: (c: string, v: unknown) => { call.eq = [c, v]; return chain; },
          select: () => ({ data: opts.rows?.[table] ?? [], error: null }),
        };
        return chain;
      },
    }),
    rpc: (fn: string) => { rpcs.push(fn); return Promise.resolve({ error: null }); },
  };
  return { db, upserts, updates, rpcs };
}

const ITEM = {
  id: "ITEM-1",
  item_data: {
    name: "Epic Hazy IPA (Cans)",
    variations: [
      { id: "VAR-1", item_variation_data: { name: "Regular", track_inventory: true, stockable: true } },
    ],
  },
};

beforeEach(() => {
  fetchItems.mockReset();
  fetchCategories.mockReset().mockResolvedValue([]);
  fetchTaxes.mockReset().mockResolvedValue([]);
});

describe("syncSquareCatalog", () => {
  it("stamps is_deleted:false on every upserted row so a recreated object is revived", async () => {
    fetchItems.mockResolvedValue([ITEM]);
    const { db, upserts } = fakeDb();

    await syncSquareCatalog(db);

    const itemRow = upserts.find((u) => u.table === "square_catalog_items")!.rows[0];
    const varRow = upserts.find((u) => u.table === "square_catalog_variations")!.rows[0];
    expect(itemRow.is_deleted).toBe(false);
    expect(varRow.is_deleted).toBe(false);
  });

  it("flags rows this run did not touch, scoped by synced_at", async () => {
    fetchItems.mockResolvedValue([ITEM]);
    const { db, updates } = fakeDb({
      rows: { square_catalog_items: [{ id: "a" }], square_catalog_variations: [{ id: "b" }, { id: "c" }] },
    });

    const res = await syncSquareCatalog(db);

    expect(res.itemsMarkedDeleted).toBe(1);
    expect(res.variationsMarkedDeleted).toBe(2);
    for (const u of updates) {
      expect(u.patch).toEqual({ is_deleted: true });
      expect(u.lt?.[0]).toBe("synced_at");
      // Only rows not already flagged, so the count reports genuinely new deaths.
      expect(u.eq).toEqual(["is_deleted", false]);
    }
  });

  // The guard that matters most: an empty catalog response must never be read as
  // "every product was deleted". That would flag all 424 mirror rows at once and
  // take every mapping down with them.
  it("refuses to run the deletion pass when Square returns no items", async () => {
    fetchItems.mockResolvedValue([]);
    const { db, updates } = fakeDb();

    const res = await syncSquareCatalog(db);

    expect(updates).toEqual([]);
    expect(res.itemsMarkedDeleted).toBe(0);
    expect(res.variationsMarkedDeleted).toBe(0);
    expect(res.deletionPassSkipped).toMatch(/refusing/i);
  });

  it("backfills link variation ids so re-pointed links pick up their mirror row", async () => {
    fetchItems.mockResolvedValue([ITEM]);
    const { db, rpcs } = fakeDb();

    await syncSquareCatalog(db);

    expect(rpcs).toContain("backfill_recipe_link_variation_ids");
  });
});

describe("markMissingAsDeleted", () => {
  it("surfaces a failed update rather than reporting zero deaths", async () => {
    const db = {
      from: () => ({
        update: () => {
          const chain = {
            lt: () => chain,
            eq: () => chain,
            select: () => ({ data: null, error: { message: "nope" } }),
          };
          return chain;
        },
      }),
      rpc: () => Promise.resolve({ error: null }),
    };
    await expect(markMissingAsDeleted(db, "square_catalog_variations", "2026-08-03T00:00:00Z"))
      .rejects.toThrow("nope");
  });
});

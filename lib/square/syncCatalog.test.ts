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

/** Variations the mirror already holds, keyed by square_variation_id. */
type ExistingDerived = Record<string, { volume_fl_oz_per_unit: number | null; inventory_unit: string | null }>;

function fakeDb(opts: { rows?: Record<string, { id: string }[]>; existing?: ExistingDerived } = {}) {
  const upserts: { table: string; rows: Record<string, unknown>[] }[] = [];
  const updates: UpdateCall[] = [];
  const rpcs: string[] = [];

  const db = {
    from: (table: string) => ({
      // Reads the already-stored derived columns (fetchExistingDerived).
      select: () => ({
        in: (_col: string, ids: string[]) => ({
          data: ids
            .filter((id) => opts.existing?.[id])
            .map((id) => ({ square_variation_id: id, ...opts.existing![id] })),
          error: null,
        }),
      }),
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

describe("derived volumes are forward-only", () => {
  // volume_fl_oz_per_unit is parsed from the variation NAME, and sell-through
  // reads it against HISTORICAL sales. Overwriting it on a rename silently
  // restates every pour ever recorded against that SKU — rename
  // "Draft - 16oz" to "Draft - 12oz" and yesterday's pours shrink by a quarter.
  const POUR_ITEM = {
    id: "ITEM-P",
    item_data: {
      name: "Epic Hazy IPA",
      variations: [{ id: "VAR-P", item_variation_data: { name: "Draft - 12oz", track_inventory: true } }],
    },
  };

  beforeEach(() => {
    fetchItems.mockResolvedValue([POUR_ITEM]);
    fetchCategories.mockResolvedValue([]);
    fetchTaxes.mockResolvedValue([]);
  });

  it("never rewrites the stored volume of a variation it has seen before", async () => {
    const { db, upserts } = fakeDb({
      existing: { "VAR-P": { volume_fl_oz_per_unit: 16, inventory_unit: "each" } },
    });

    const result = await syncSquareCatalog(db);

    const varRows = upserts.filter((u) => u.table === "square_catalog_variations").flatMap((u) => u.rows);
    expect(varRows).toHaveLength(1);
    // Name refreshed from Square, volume left exactly as stored.
    expect(varRows[0]).toMatchObject({ variation_name: "Draft - 12oz", volume_fl_oz_per_unit: 16 });
    expect(result.variationsInserted).toBe(0);
    expect(result.variationsUpdated).toBe(1);
  });

  it("reports the rename instead of applying it", async () => {
    const { db } = fakeDb({
      existing: { "VAR-P": { volume_fl_oz_per_unit: 16, inventory_unit: "each" } },
    });

    const result = await syncSquareCatalog(db);

    expect(result.volumeMismatches).toEqual([
      { squareVariationId: "VAR-P", variationName: "Draft - 12oz", stored: 16, impliedByName: 12 },
    ]);
  });

  it("does derive the volume for a variation it has never seen", async () => {
    const { db, upserts } = fakeDb({ existing: {} });

    const result = await syncSquareCatalog(db);

    const varRows = upserts.filter((u) => u.table === "square_catalog_variations").flatMap((u) => u.rows);
    expect(varRows[0]).toMatchObject({ volume_fl_oz_per_unit: 12 });
    expect(result.variationsInserted).toBe(1);
    expect(result.volumeMismatches).toEqual([]);
  });
});

describe("scoped sync", () => {
  // Pulling one item into the mirror at link time must never run the deletion
  // pass: it flags every row the run did not touch, which for a one-item run is
  // the whole catalog.
  it("skips the deletion pass when scoped to specific items", async () => {
    fetchItems.mockResolvedValue([ITEM]);
    fetchCategories.mockResolvedValue([]);
    fetchTaxes.mockResolvedValue([]);
    const { db, updates } = fakeDb({ existing: {} });

    const result = await syncSquareCatalog(db, { onlyItemIds: ["ITEM-1"] });

    expect(result.deletionPassSkipped).toMatch(/scoped/i);
    expect(result.itemsMarkedDeleted).toBe(0);
    expect(updates.some((u) => u.patch.is_deleted === true)).toBe(false);
  });

  it("mirrors only the named item", async () => {
    const OTHER = { id: "ITEM-2", item_data: { name: "Other", variations: [
      { id: "VAR-2", item_variation_data: { name: "Regular" } },
    ] } };
    fetchItems.mockResolvedValue([ITEM, OTHER]);
    fetchCategories.mockResolvedValue([]);
    fetchTaxes.mockResolvedValue([]);
    const { db, upserts } = fakeDb({ existing: {} });

    await syncSquareCatalog(db, { onlyItemIds: ["ITEM-2"] });

    const itemRows = upserts.filter((u) => u.table === "square_catalog_items").flatMap((u) => u.rows);
    expect(itemRows.map((r) => r.square_item_id)).toEqual(["ITEM-2"]);
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

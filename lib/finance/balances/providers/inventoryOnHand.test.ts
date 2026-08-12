// The Inventory Assets provider. Three things here are load-bearing and each
// has a way of quietly going wrong:
//   * an unset pool must read as UNSOURCED (null), never as a real $0 -- an
//     inventory account is the last place to show a confident zero;
//   * partner-owned packaging must be filtered in the QUERY, so it stays out
//     the day somebody fills in its unit cost;
//   * the answer is in CENTS, from decimal-dollar columns.
import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { inventoryOnHand, INVENTORY_POOL_KEY } from "./inventoryOnHand";
import type { BalanceContext } from "../registry";

/** Records the table and any `.is()` filters, and returns `rows` from the first page. */
function fakeClient(rows: Record<string, unknown>[]) {
  const seen = { table: "", isFilters: [] as [string, unknown][] };
  const chain: Record<string, unknown> = {
    select: () => chain,
    order: () => chain,
    is: (col: string, val: unknown) => {
      seen.isFilters.push([col, val]);
      return chain;
    },
    // fetchAllRows pages with .range(); page 2 onward is empty.
    range: (from: number) => Promise.resolve({ data: from === 0 ? rows : [], error: null }),
  };
  const supabase = {
    from: (table: string) => {
      seen.table = table;
      return chain;
    },
  } as unknown as SupabaseClient;
  return { supabase, seen };
}

function ctx(supabase: SupabaseClient, config: Record<string, unknown>): BalanceContext {
  return { supabase, coaId: "coa-1210", periodEnd: "2026-07-31", config };
}

describe("inventoryOnHand", () => {
  it("returns null when no pool has been chosen, so the account reads as unsourced rather than empty", async () => {
    const { supabase } = fakeClient([]);

    expect(await inventoryOnHand.compute(ctx(supabase, {}))).toBeNull();
  });

  it("returns null for a pool it does not recognise", async () => {
    const { supabase } = fakeClient([]);

    expect(await inventoryOnHand.compute(ctx(supabase, { [INVENTORY_POOL_KEY]: "taproomMerchandise" }))).toBeNull();
  });

  it("values raw materials as quantity x unit cost, in cents", async () => {
    const { supabase, seen } = fakeClient([
      { stock_quantity: 10, cost_per_unit_usd: 2.5 },
      { stock_quantity: 3, cost_per_unit_usd: 1.1 },
    ]);

    const result = await inventoryOnHand.compute(ctx(supabase, { [INVENTORY_POOL_KEY]: "rawMaterials" }));

    expect(seen.table).toBe("ingredients");
    expect(result).toBe(28_30);
  });

  it("values packaging materials from packaging_items, excluding partner-owned stock", async () => {
    const { supabase, seen } = fakeClient([{ stock_quantity: 200, unit_cost_usd: 0.42 }]);

    const result = await inventoryOnHand.compute(ctx(supabase, { [INVENTORY_POOL_KEY]: "packagingMaterials" }));

    expect(seen.table).toBe("packaging_items");
    // The filter belongs in the query, not in a later reduce: a partner carton
    // that gets priced tomorrow must still be excluded tomorrow.
    expect(seen.isFilters).toContainEqual(["partner_id", null]);
    expect(result).toBe(84_00);
  });

  it("counts an unpriced item as nothing rather than failing the whole account", async () => {
    const { supabase } = fakeClient([
      { stock_quantity: 4, cost_per_unit_usd: null },
      { stock_quantity: 2, cost_per_unit_usd: 5 },
    ]);

    expect(await inventoryOnHand.compute(ctx(supabase, { [INVENTORY_POOL_KEY]: "rawMaterials" }))).toBe(10_00);
  });

  it("reads each pool once per run, so 1210 and 1220 in one pass do not re-fetch", async () => {
    const { supabase } = fakeClient([{ stock_quantity: 1, cost_per_unit_usd: 1 }]);
    const spy = vi.spyOn(supabase, "from");
    const shared = new Map<string, Promise<unknown>>();
    const config = { [INVENTORY_POOL_KEY]: "rawMaterials" };

    await inventoryOnHand.compute({ ...ctx(supabase, config), shared });
    await inventoryOnHand.compute({ ...ctx(supabase, config), shared });

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("is excluded from closed months, because stock_quantity is only ever today's count", () => {
    expect(inventoryOnHand.dependsOnCurrentState).toBe(true);
  });
});

// ── Finished goods ───────────────────────────────────────────────────────────

/** Serves a different row set per table, and records which tables were asked for. */
function fakeTables(tables: Record<string, Record<string, unknown>[]>) {
  const asked: string[] = [];
  const supabase = {
    from: (table: string) => {
      asked.push(table);
      const chain: Record<string, unknown> = {
        select: () => chain,
        order: () => chain,
        is: () => chain,
        range: (from: number) => Promise.resolve({ data: from === 0 ? (tables[table] ?? []) : [], error: null }),
      };
      return chain;
    },
  } as unknown as SupabaseClient;
  return { supabase, asked };
}

const CAN = { id: "can", type: "can", name: "16oz can", unit_cost_usd: 0.14, can_count: null };
const LID = { id: "lid", type: "lid", name: "Lid", unit_cost_usd: 0.08, can_count: null };
const TRAY = { id: "tray", type: "tray", name: "Case tray", unit_cost_usd: 0.51, can_count: 24 };
const KEG = { id: "keg", type: "keg", name: "Sixtel", unit_cost_usd: 120, can_count: null };

/** One bbl of beer costing $50, so the arithmetic below stays checkable by hand. */
const recipeBill = [{ recipe_id: "r1", quantity_per_bbl: 1, ingredients: { cost_per_unit_usd: 50 } }];

function finishedGoods(tables: Record<string, Record<string, unknown>[]>) {
  const { supabase, asked } = fakeTables(tables);
  return {
    asked,
    result: inventoryOnHand.compute(ctx(supabase, { [INVENTORY_POOL_KEY]: "finishedGoods" })),
  };
}

describe("inventoryOnHand — finished goods", () => {
  it("prices a case as the beer it holds plus every packaging component", async () => {
    const { result } = finishedGoods({
      cold_storage_inventory: [{ recipe_id: "r1", variation_id: "v1", quantity_on_hand: 2 }],
      packaging_variations: [
        {
          id: "v1",
          format: "case",
          // 24 x 16oz
          total_volume_fl_oz: 384,
          container_id: "can",
          lid_id: "lid",
          label_id: null,
          paktech_id: null,
          tray_id: "tray",
        },
      ],
      packaging_items: [CAN, LID, TRAY],
      recipe_ingredients: recipeBill,
    });

    // Beer: 2 cases x (384/3968) bbl x $50/bbl = $9.68 (rounded from 9.6774).
    // Packaging: 48 cans x $0.14 + 48 lids x $0.08 + 2 trays x $0.51 = $11.58.
    expect(await result).toBe(968 + 1158);
  });

  it("leaves the keg itself out — a returnable vessel is not packaging the beer consumed", async () => {
    const { result } = finishedGoods({
      cold_storage_inventory: [{ recipe_id: "r1", variation_id: "v2", quantity_on_hand: 1 }],
      packaging_variations: [
        {
          id: "v2",
          format: "loose",
          total_volume_fl_oz: 3968, // one bbl, to keep the beer half at exactly $50
          container_id: "keg",
          lid_id: null,
          label_id: null,
          paktech_id: null,
          tray_id: null,
        },
      ],
      // The keg is priced here on purpose: the exclusion must be a rule, not an
      // accident of every keg currently having a null cost.
      packaging_items: [KEG],
      recipe_ingredients: recipeBill,
    });

    expect(await result).toBe(50_00);
  });

  it("counts beer brewed to a partner's recipe — it is only theirs once it ships", async () => {
    const { asked, result } = finishedGoods({
      cold_storage_inventory: [{ recipe_id: "r1", variation_id: "v3", quantity_on_hand: 1 }],
      packaging_variations: [
        {
          id: "v3",
          format: "loose",
          total_volume_fl_oz: 3968,
          container_id: null,
          lid_id: null,
          label_id: null,
          paktech_id: null,
          tray_id: null,
        },
      ],
      packaging_items: [],
      recipe_ingredients: recipeBill,
    });

    expect(await result).toBe(50_00);
    // Nothing may consult the partner tables to decide this. Ownership passes at
    // shipment, and every cold-storage batch today is against a partner recipe --
    // so a partner filter would silently empty the whole account.
    expect(asked).not.toContain("contract_brewing_partners");
    expect(asked).not.toContain("recipes");
  });

  it("values a beer whose recipe has no ingredients entered at packaging cost only, rather than failing", async () => {
    const { result } = finishedGoods({
      cold_storage_inventory: [{ recipe_id: "unpriced", variation_id: "v4", quantity_on_hand: 10 }],
      packaging_variations: [
        {
          id: "v4",
          format: "loose",
          total_volume_fl_oz: 16,
          container_id: "can",
          lid_id: null,
          label_id: null,
          paktech_id: null,
          tray_id: null,
        },
      ],
      packaging_items: [CAN],
      recipe_ingredients: recipeBill,
    });

    // 10 cans x $0.14, and no beer cost. Understates; does not blank the account.
    expect(await result).toBe(1_40);
  });

  it("returns 0, not a crash, when cold storage is empty", async () => {
    const { result } = finishedGoods({ cold_storage_inventory: [] });

    expect(await result).toBe(0);
  });
});
